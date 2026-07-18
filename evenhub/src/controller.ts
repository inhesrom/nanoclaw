import { EvenHubApiError, type EvenHubApiPort, type LiveTurn } from './api';
import {
  anchorConversationEntry,
  projectConversationFeed,
  scrollConversation,
  type ConversationProjection,
} from './conversation-layout';
import {
  conversationEntries,
  initialState,
  reduceAppState,
  type ActiveTurn,
  type AppAction,
  type AppState,
  type ConfirmationDecision,
  type ServerTurn,
} from './state';
import { STORAGE_KEYS, type StoragePort } from './storage';

export interface TurnControllerOptions {
  api: EvenHubApiPort;
  storage: StoragePort;
  onState: (state: AppState) => void;
  delay?: (milliseconds: number) => Promise<void>;
  createIdempotencyKey?: () => string;
  now?: () => number;
}

interface PendingUpload {
  pcm: Uint8Array;
  durationMs: number;
  idempotencyKey: string;
}

interface PendingText {
  text: string;
  idempotencyKey: string;
}

export const MAX_TEXT_CODE_POINTS = 2_000;

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export class TurnController {
  private stateValue: AppState = initialState;
  private token: string | null = null;
  private pendingUpload?: PendingUpload;
  private pendingText?: PendingText;
  private liveTurn?: LiveTurn;
  private recordingIdempotencyKey?: string;
  private restoredState?: { hasToken: boolean; activeTurn?: ActiveTurn };
  private readinessBlocked = false;
  private confirmation?: Promise<ConfirmationDecision | undefined>;
  private generation = 0;

  constructor(private readonly options: TurnControllerOptions) {
    this.options.onState(this.stateValue);
  }

  get state(): AppState {
    return this.stateValue;
  }

  async boot(): Promise<void> {
    const [token, activeTurnId, activeIdempotencyKey] = await Promise.all([
      this.options.storage.get(STORAGE_KEYS.token),
      this.options.storage.get(STORAGE_KEYS.activeTurnId),
      this.options.storage.get(STORAGE_KEYS.activeIdempotencyKey),
    ]);
    this.token = token || null;
    const activeTurn =
      activeTurnId && activeIdempotencyKey
        ? { id: activeTurnId, idempotencyKey: activeIdempotencyKey }
        : undefined;
    this.restoredState = { hasToken: Boolean(token), activeTurn };
    await this.restoreWhenReady();
  }

  async pair(code: string, deviceName = 'Even G2'): Promise<void> {
    let result;
    try {
      result = await this.options.api.pair(code, deviceName);
    } catch (error) {
      this.dispatch({ type: 'PAIR_FAILED', message: errorMessage(error) });
      throw error;
    }
    await this.options.storage.set(STORAGE_KEYS.token, result.token);
    this.token = result.token;
    this.restoredState = { hasToken: true };
    await this.restoreWhenReady();
  }

  startRecording(startedAt = Date.now()): boolean {
    this.dispatch({ type: 'RECORD_STARTED', startedAt });
    if (!this.token || this.stateValue.kind !== 'recording') return false;
    this.recordingIdempotencyKey =
      this.options.createIdempotencyKey?.() ?? crypto.randomUUID();
    this.liveTurn = this.options.api.startLiveTurn?.(
      this.token,
      this.recordingIdempotencyKey,
      ({ finalText, interimText }) => {
        const state = this.stateValue;
        if (
          (state.kind === 'recording' || state.kind === 'stopping') &&
          state.finalText === finalText &&
          state.interimText === interimText
        ) {
          return;
        }
        this.dispatch({ type: 'TRANSCRIPT_SNAPSHOT', finalText, interimText });
      },
    );
    return true;
  }

  recordingProgress(bytes: number): void {
    this.dispatch({ type: 'RECORD_PROGRESS', bytes });
  }

  recordingStopped(): void {
    this.dispatch({ type: 'RECORD_STOP_REQUESTED' });
  }

  streamPcm(pcm: Uint8Array): void {
    this.liveTurn?.push(pcm);
  }

  recordingFailed(message: string): void {
    this.liveTurn?.abort();
    this.liveTurn = undefined;
    this.recordingIdempotencyKey = undefined;
    this.dispatch({ type: 'FAILED', message, retryable: false });
  }

  async submit(pcm: Uint8Array, durationMs: number): Promise<void> {
    if (!this.token) {
      this.dispatch({
        type: 'PAIRING_REQUIRED',
        message: 'Pair this companion before sending a turn.',
      });
      return;
    }
    const idempotencyKey =
      this.recordingIdempotencyKey ??
      this.options.createIdempotencyKey?.() ??
      crypto.randomUUID();
    this.recordingIdempotencyKey = undefined;
    this.pendingUpload = { pcm, durationMs, idempotencyKey };
    await this.options.storage.set(
      STORAGE_KEYS.activeIdempotencyKey,
      idempotencyKey,
    );
    const liveTurn = this.liveTurn;
    this.liveTurn = undefined;
    if (liveTurn) {
      try {
        const result = await liveTurn.finish(pcm, durationMs);
        const activeTurn = {
          id: result.turnId,
          idempotencyKey,
        };
        await this.options.storage.set(
          STORAGE_KEYS.activeTurnId,
          result.turnId,
        );
        this.pendingUpload = undefined;
        this.dispatch({ type: 'STREAM_FINAL', turn: activeTurn, result });
        if (await this.consumeTurn(activeTurn, result)) return;
        await this.poll(activeTurn);
        return;
      } catch {
        // The complete retained PCM is submitted below with the same key.
      }
    }
    await this.uploadPending();
  }

  async submitText(rawText: string): Promise<boolean> {
    if (!this.token) {
      this.dispatch({
        type: 'PAIRING_REQUIRED',
        message: 'Pair this companion before sending a turn.',
      });
      return false;
    }
    const text = normalizeTextPrompt(rawText);
    if (
      this.stateValue.kind !== 'ready' ||
      !this.stateValue.capabilities?.text ||
      !text ||
      [...text].length > MAX_TEXT_CODE_POINTS
    ) {
      return false;
    }
    this.pendingText = {
      text,
      idempotencyKey:
        this.options.createIdempotencyKey?.() ?? crypto.randomUUID(),
    };
    return this.submitPendingText();
  }

  async retry(): Promise<void> {
    if (this.pendingText) {
      await this.submitPendingText();
      return;
    }
    if (this.pendingUpload) {
      await this.uploadPending();
      return;
    }
    if (this.readinessBlocked) {
      await this.restoreWhenReady();
      return;
    }
    if (this.stateValue.kind === 'error' && this.stateValue.activeTurn) {
      const activeTurn = this.stateValue.activeTurn;
      this.dispatch({
        type: 'RESTORED',
        hasToken: true,
        activeTurn,
      });
      await this.poll(activeTurn);
      return;
    }
    if (this.stateValue.kind === 'error') {
      await this.newTurn();
    }
  }

  openConfirmationChoice(): void {
    this.dispatch({ type: 'CONFIRMATION_OPEN' });
  }

  closeConfirmationChoice(): void {
    this.dispatch({ type: 'CONFIRMATION_CLOSE' });
  }

  toggleConfirmationChoice(): void {
    this.dispatch({ type: 'CONFIRMATION_TOGGLE' });
  }

  scroll(direction: -1 | 1): void {
    const projection = this.conversationProjection();
    this.dispatch({
      type: 'SCROLLED',
      offset: scrollConversation(projection, direction),
    });
  }

  conversationProjection(): ConversationProjection {
    return conversationProjectionForState(this.stateValue);
  }

  confirm(
    decision = this.stateValue.kind === 'review'
      ? this.stateValue.choice
      : undefined,
  ): Promise<ConfirmationDecision | undefined> {
    if (!decision || this.stateValue.kind !== 'review') {
      return Promise.resolve(undefined);
    }
    if (this.confirmation) return this.confirmation;
    this.confirmation = this.resolveConfirmation(decision).finally(() => {
      this.confirmation = undefined;
    });
    return this.confirmation;
  }

  async newTurn(): Promise<void> {
    this.generation += 1;
    this.liveTurn?.abort();
    this.liveTurn = undefined;
    this.recordingIdempotencyKey = undefined;
    this.pendingUpload = undefined;
    this.pendingText = undefined;
    this.confirmation = undefined;
    this.dispatch({ type: 'READY' });
    await this.clearActiveTurn();
  }

  dispose(): void {
    this.generation += 1;
    this.liveTurn?.abort();
    this.liveTurn = undefined;
    this.recordingIdempotencyKey = undefined;
    this.pendingUpload = undefined;
    this.pendingText = undefined;
    this.confirmation = undefined;
  }

  private async uploadPending(): Promise<void> {
    const upload = this.pendingUpload;
    const token = this.token;
    if (!upload || !token) return;
    this.dispatch({
      type: 'UPLOAD_STARTED',
      idempotencyKey: upload.idempotencyKey,
    });
    await this.options.storage.set(
      STORAGE_KEYS.activeIdempotencyKey,
      upload.idempotencyKey,
    );

    let lastError: unknown;
    for (const backoff of [0, 500, 1_000, 2_000]) {
      if (backoff > 0) await this.delay(backoff);
      try {
        const result = await this.options.api.submitTurn(
          token,
          upload.pcm,
          upload.durationMs,
          upload.idempotencyKey,
        );
        const activeTurn = {
          id: result.turnId,
          idempotencyKey: upload.idempotencyKey,
        };
        await this.options.storage.set(
          STORAGE_KEYS.activeTurnId,
          result.turnId,
        );
        this.pendingUpload = undefined;
        this.dispatch({ type: 'TURN_ACCEPTED', turn: activeTurn });
        if (await this.consumeTurn(activeTurn, result)) return;
        await this.poll(activeTurn);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof EvenHubApiError && !error.retryable) break;
      }
    }
    await this.handleFailure(
      lastError,
      undefined,
      !(lastError instanceof EvenHubApiError) || lastError.retryable,
    );
  }

  private async submitPendingText(): Promise<boolean> {
    const pending = this.pendingText;
    const token = this.token;
    if (!pending || !token) return false;
    this.dispatch({
      type: 'TEXT_SUBMIT_STARTED',
      idempotencyKey: pending.idempotencyKey,
      text: pending.text,
    });
    if (this.stateValue.kind !== 'submitting_text') return false;

    let lastError: unknown;
    for (const backoff of [0, 500, 1_000, 2_000]) {
      if (backoff > 0) await this.delay(backoff);
      try {
        const result = await this.options.api.submitTextTurn(
          token,
          pending.text,
          pending.idempotencyKey,
        );
        const activeTurn = {
          id: result.turnId,
          idempotencyKey: pending.idempotencyKey,
        };
        await Promise.all([
          this.options.storage.set(STORAGE_KEYS.activeTurnId, result.turnId),
          this.options.storage.set(
            STORAGE_KEYS.activeIdempotencyKey,
            pending.idempotencyKey,
          ),
        ]);
        this.pendingText = undefined;
        this.dispatch({ type: 'TEXT_ACCEPTED', turn: activeTurn, result });
        if (!(await this.consumeTurn(activeTurn, result))) {
          void this.poll(activeTurn);
        }
        return true;
      } catch (error) {
        lastError = error;
        if (error instanceof EvenHubApiError && !error.retryable) break;
      }
    }
    await this.handleFailure(
      lastError,
      undefined,
      !(lastError instanceof EvenHubApiError) || lastError.retryable,
    );
    return false;
  }

  private async poll(activeTurn: ActiveTurn): Promise<void> {
    const token = this.token;
    if (!token) return;
    const generation = ++this.generation;
    const startedAt = this.now();
    let polls = 0;
    let failures = 0;
    while (generation === this.generation) {
      const elapsedMs = this.now() - startedAt;
      if (elapsedMs >= 5 * 60_000) {
        await this.handleFailure(
          new Error('Still working—watch WhatsApp. Reopen to resume.'),
          activeTurn,
          true,
        );
        return;
      }
      try {
        const result = await this.options.api.getTurn(token, activeTurn.id);
        failures = 0;
        if (await this.consumeTurn(activeTurn, result)) return;
        polls += 1;
        if (elapsedMs >= 30_000) {
          this.dispatch({
            type: 'POLL_NOTICE',
            message: 'Still working—watch WhatsApp',
          });
        }
        const pollDelay = Math.min(
          result.pollAfterMs * 2 ** Math.floor((polls - 1) / 10),
          2_000,
        );
        await this.delay(pollDelay);
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof EvenHubApiError) {
          if (error.status === 404) {
            await this.clearActiveTurn();
            this.dispatch({
              type: 'FAILED',
              message: 'Turn expired; record a new turn.',
              retryable: false,
            });
            return;
          }
          if (!error.retryable) {
            await this.handleFailure(error, activeTurn, false);
            return;
          }
        }
        failures += 1;
        if (failures >= 5) {
          await this.handleFailure(error, activeTurn, true);
          return;
        }
        await this.delay(Math.min(500 * 2 ** (failures - 1), 4_000));
      }
    }
  }

  private async consumeTurn(
    activeTurn: ActiveTurn,
    result: ServerTurn,
  ): Promise<boolean> {
    if (result.state === 'awaiting_confirmation') {
      this.dispatch({ type: 'TURN_UPDATED', turn: activeTurn, result });
      return true;
    }
    if (result.state === 'completed') {
      await this.options.storage.set(
        STORAGE_KEYS.lastCompletedTurnId,
        result.turnId,
      );
      await this.clearActiveTurn();
      this.dispatch({
        type: 'TURN_COMPLETED',
        turnId: result.turnId,
        transcript: result.transcript,
        reply: result.answer || '',
      });
      return true;
    }
    if (result.state === 'failed') {
      await this.clearActiveTurn();
      this.dispatch({
        type: 'TURN_FAILED',
        turnId: result.turnId,
        transcript: result.transcript,
        message:
          result.error?.message || 'NanoClaw could not process this turn.',
      });
      return true;
    }
    if (result.state === 'discarded') {
      await this.clearActiveTurn();
      this.dispatch({ type: 'TURN_DISCARDED' });
      return true;
    }
    this.dispatch({ type: 'TURN_UPDATED', turn: activeTurn, result });
    return false;
  }

  private async resolveConfirmation(
    decision: ConfirmationDecision,
  ): Promise<ConfirmationDecision | undefined> {
    const state = this.stateValue;
    const token = this.token;
    if (state.kind !== 'review' || !token) return undefined;
    const activeTurn = state.turn;
    try {
      const result = await this.options.api.confirmTurn(
        token,
        activeTurn.id,
        decision,
      );
      const terminal = await this.consumeTurn(activeTurn, result);
      if (!terminal) void this.poll(activeTurn);
      return result.state === 'discarded' ? 'discard' : 'send';
    } catch (error) {
      if (error instanceof EvenHubApiError && error.status === 409) {
        try {
          const resolved = await this.options.api.getTurn(token, activeTurn.id);
          const terminal = await this.consumeTurn(activeTurn, resolved);
          if (!terminal) void this.poll(activeTurn);
          if (resolved.state === 'discarded') return 'discard';
          if (
            resolved.state === 'dispatching' ||
            resolved.state === 'queued' ||
            resolved.state === 'running' ||
            resolved.state === 'completed'
          ) {
            return 'send';
          }
          return undefined;
        } catch (refreshError) {
          error = refreshError;
        }
      }
      if (error instanceof EvenHubApiError && error.status === 401) {
        await this.handleFailure(error, activeTurn, false);
        return undefined;
      }
      this.dispatch({
        type: 'CONFIRMATION_FAILED',
        message: `${errorMessage(error)} Draft not sent.`,
      });
      throw error;
    }
  }

  private async handleFailure(
    error: unknown,
    activeTurn: ActiveTurn | undefined,
    retryable: boolean,
  ): Promise<void> {
    if (error instanceof EvenHubApiError && error.status === 401) {
      this.token = null;
      await Promise.all([
        this.options.storage.set(STORAGE_KEYS.token, ''),
        this.clearActiveTurn(),
      ]);
      this.dispatch({
        type: 'PAIRING_REQUIRED',
        message: 'This device token was revoked. Pair the companion again.',
      });
      return;
    }
    this.dispatch({
      type: 'FAILED',
      message: errorMessage(error),
      retryable,
      activeTurn,
    });
  }

  private async restoreWhenReady(): Promise<void> {
    const restored = this.restoredState;
    if (!restored) return;
    if (!restored.hasToken) {
      this.dispatch({ type: 'RESTORED', ...restored });
      return;
    }
    try {
      const result = await this.options.api.getCapabilities();
      this.dispatch({
        type: 'CAPABILITIES_UPDATED',
        capabilities: result.capabilities,
      });
    } catch (error) {
      this.readinessBlocked = true;
      this.dispatch({
        type: 'FAILED',
        message: errorMessage(error),
        retryable: true,
        activeTurn: restored.activeTurn,
      });
      return;
    }
    this.readinessBlocked = false;
    this.dispatch({ type: 'RESTORED', ...restored });
    if (this.token && restored.activeTurn) void this.poll(restored.activeTurn);
  }

  private async clearActiveTurn(): Promise<void> {
    await Promise.all([
      this.options.storage.set(STORAGE_KEYS.activeTurnId, ''),
      this.options.storage.set(STORAGE_KEYS.activeIdempotencyKey, ''),
    ]);
  }

  private delay(milliseconds: number): Promise<void> {
    return (this.options.delay ?? defaultDelay)(milliseconds);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private dispatch(action: AppAction): void {
    this.stateValue = reduceAppState(this.stateValue, action);
    this.options.onState(this.stateValue);
  }
}

function normalizeTextPrompt(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function conversationProjectionForState(
  state: AppState,
): ConversationProjection {
  const entries = conversationEntries(state);
  const all = projectConversationFeed(entries, { offset: 0 });
  let offset = all.maxOffset;
  const session = state.session;
  if (session.manuallyScrolled) {
    offset = session.scrollOffset;
  } else if (session.anchorTurnId) {
    const replyId = entries.some(
      (entry) => entry.id === `${session.anchorTurnId}:reply`,
    )
      ? `${session.anchorTurnId}:reply`
      : `${session.anchorTurnId}:failure`;
    offset = anchorConversationEntry(all, replyId);
  }
  return projectConversationFeed(entries, { offset });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'NanoClaw is not reachable.';
}
