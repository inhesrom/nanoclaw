import { EvenHubApiError, type EvenHubApiPort } from './api';
import {
  initialState,
  reduceAppState,
  type ActiveTurn,
  type AppAction,
  type AppState,
  type ServerTurn,
} from './state';
import { STORAGE_KEYS, type StoragePort } from './storage';

export interface TurnControllerOptions {
  api: EvenHubApiPort;
  storage: StoragePort;
  paginateAnswer: (answer: string) => string[];
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

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export class TurnController {
  private stateValue: AppState = initialState;
  private token: string | null = null;
  private pendingUpload?: PendingUpload;
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
    this.dispatch({ type: 'RESTORED', hasToken: Boolean(token), activeTurn });
    if (this.token && activeTurn) void this.poll(activeTurn);
  }

  async pair(code: string, deviceName = 'Even G2'): Promise<void> {
    try {
      const result = await this.options.api.pair(code, deviceName);
      await this.options.storage.set(STORAGE_KEYS.token, result.token);
      this.token = result.token;
      this.dispatch({ type: 'PAIRED' });
    } catch (error) {
      this.dispatch({ type: 'PAIR_FAILED', message: errorMessage(error) });
      throw error;
    }
  }

  startRecording(startedAt = Date.now()): void {
    this.dispatch({ type: 'RECORD_STARTED', startedAt });
  }

  recordingProgress(bytes: number): void {
    this.dispatch({ type: 'RECORD_PROGRESS', bytes });
  }

  recordingStopped(): void {
    this.dispatch({ type: 'RECORD_STOP_REQUESTED' });
  }

  recordingFailed(message: string): void {
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
      this.options.createIdempotencyKey?.() ?? crypto.randomUUID();
    this.pendingUpload = { pcm, durationMs, idempotencyKey };
    await this.uploadPending();
  }

  async retry(): Promise<void> {
    if (this.pendingUpload) {
      await this.uploadPending();
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

  nextPage(): void {
    this.dispatch({ type: 'PAGE_NEXT' });
  }

  previousPage(): void {
    this.dispatch({ type: 'PAGE_PREVIOUS' });
  }

  async newTurn(): Promise<void> {
    this.generation += 1;
    this.pendingUpload = undefined;
    this.dispatch({ type: 'READY' });
    await this.clearActiveTurn();
  }

  dispose(): void {
    this.generation += 1;
    this.pendingUpload = undefined;
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
    if (result.state === 'completed') {
      const pages = this.options.paginateAnswer(result.answer || '');
      await this.options.storage.set(
        STORAGE_KEYS.lastCompletedTurnId,
        result.turnId,
      );
      await this.clearActiveTurn();
      this.dispatch({
        type: 'TURN_COMPLETED',
        turnId: result.turnId,
        transcript: result.transcript,
        pages,
      });
      return true;
    }
    if (result.state === 'failed') {
      await this.clearActiveTurn();
      this.dispatch({
        type: 'FAILED',
        message:
          result.error?.message || 'NanoClaw could not process this turn.',
        retryable: result.error?.retryable ?? false,
      });
      return true;
    }
    this.dispatch({ type: 'TURN_UPDATED', turn: activeTurn, result });
    return false;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'NanoClaw is not reachable.';
}
