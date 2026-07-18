import type { ConversationEntry } from './conversation-layout';

export type ServerTurnState =
  | 'accepted'
  | 'transcribing'
  | 'awaiting_confirmation'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'discarded';

export type ConfirmationDecision = 'send' | 'discard';

export interface AppCapabilities {
  voice: boolean;
  text: boolean;
}

export interface ServerTurn {
  turnId: string;
  state: ServerTurnState;
  transcript?: string;
  answer?: string;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pollAfterMs: number;
}

export interface ActiveTurn {
  id: string;
  idempotencyKey: string;
}

export interface ConversationTurn {
  turnId: string;
  transcript?: string;
  reply?: string;
  failure?: string;
}

export interface SessionState {
  turns: ConversationTurn[];
  scrollOffset: number;
  manuallyScrolled: boolean;
  anchorTurnId?: string;
}

type AppViewState =
  | { kind: 'booting' }
  | { kind: 'pairing'; error?: string }
  | { kind: 'ready' }
  | {
      kind: 'submitting_text';
      idempotencyKey: string;
      text: string;
    }
  | {
      kind: 'recording';
      startedAt: number;
      bytes: number;
      finalText?: string;
      interimText?: string;
    }
  | { kind: 'stopping'; finalText?: string; interimText?: string }
  | {
      kind: 'uploading';
      idempotencyKey: string;
      transcript?: string;
    }
  | {
      kind: 'transcribing';
      turn: ActiveTurn;
      transcript?: string;
      notice?: string;
    }
  | {
      kind: 'review';
      turn: ActiveTurn;
      transcript: string;
      choiceOpen: boolean;
      choice: ConfirmationDecision;
      notice?: string;
    }
  | {
      kind: 'thinking';
      turn: ActiveTurn;
      transcript?: string;
      notice?: string;
    }
  | {
      kind: 'error';
      message: string;
      retryable: boolean;
      activeTurn?: ActiveTurn;
    };

export type AppState = AppViewState & {
  session: SessionState;
  capabilities?: AppCapabilities;
};

export type AppAction =
  | { type: 'RESTORED'; hasToken: boolean; activeTurn?: ActiveTurn }
  | { type: 'PAIR_FAILED'; message: string }
  | { type: 'PAIRED' }
  | { type: 'CAPABILITIES_UPDATED'; capabilities: AppCapabilities }
  | { type: 'TEXT_SUBMIT_STARTED'; idempotencyKey: string; text: string }
  | { type: 'TEXT_ACCEPTED'; turn: ActiveTurn; result: ServerTurn }
  | { type: 'RECORD_STARTED'; startedAt: number }
  | { type: 'RECORD_PROGRESS'; bytes: number }
  | { type: 'TRANSCRIPT_SNAPSHOT'; finalText: string; interimText: string }
  | { type: 'RECORD_STOP_REQUESTED' }
  | { type: 'UPLOAD_STARTED'; idempotencyKey: string }
  | { type: 'TURN_ACCEPTED'; turn: ActiveTurn }
  | { type: 'STREAM_FINAL'; turn: ActiveTurn; result: ServerTurn }
  | { type: 'TURN_UPDATED'; turn: ActiveTurn; result: ServerTurn }
  | { type: 'POLL_NOTICE'; message: string }
  | { type: 'CONFIRMATION_OPEN' }
  | { type: 'CONFIRMATION_CLOSE' }
  | { type: 'CONFIRMATION_TOGGLE' }
  | { type: 'CONFIRMATION_FAILED'; message: string }
  | {
      type: 'TURN_COMPLETED';
      turnId: string;
      transcript?: string;
      reply: string;
    }
  | {
      type: 'TURN_FAILED';
      turnId: string;
      transcript?: string;
      message: string;
    }
  | { type: 'TURN_DISCARDED' }
  | { type: 'SCROLLED'; offset: number }
  | {
      type: 'FAILED';
      message: string;
      retryable: boolean;
      activeTurn?: ActiveTurn;
    }
  | { type: 'READY' }
  | { type: 'PAIRING_REQUIRED'; message?: string };

const emptySession: SessionState = {
  turns: [],
  scrollOffset: 0,
  manuallyScrolled: false,
};

export const initialState: AppState = {
  kind: 'booting',
  session: emptySession,
  capabilities: { voice: false, text: false },
};

export function reduceAppState(state: AppState, action: AppAction): AppState {
  const session = state.session;
  const capabilities = state.capabilities ?? { voice: false, text: false };
  switch (action.type) {
    case 'RESTORED':
      if (!action.hasToken) return { kind: 'pairing', session, capabilities };
      return action.activeTurn
        ? {
            kind: 'transcribing',
            turn: action.activeTurn,
            session,
            capabilities,
          }
        : { kind: 'ready', session, capabilities };
    case 'PAIR_FAILED':
      return { kind: 'pairing', error: action.message, session, capabilities };
    case 'PAIRED':
    case 'READY':
      return { kind: 'ready', session, capabilities };
    case 'CAPABILITIES_UPDATED':
      return { ...state, capabilities: action.capabilities };
    case 'PAIRING_REQUIRED':
      return {
        kind: 'pairing',
        error: action.message,
        session,
        capabilities,
      };
    case 'TEXT_SUBMIT_STARTED':
      return (state.kind === 'ready' || state.kind === 'error') &&
        capabilities.text
        ? {
            kind: 'submitting_text',
            idempotencyKey: action.idempotencyKey,
            text: action.text,
            session: {
              ...session,
              manuallyScrolled: false,
              anchorTurnId: undefined,
            },
            capabilities,
          }
        : state;
    case 'TEXT_ACCEPTED':
      return state.kind === 'submitting_text'
        ? {
            kind: 'thinking',
            turn: action.turn,
            transcript: action.result.transcript || state.text,
            session,
            capabilities,
          }
        : state;
    case 'RECORD_STARTED':
      return state.kind === 'ready' && capabilities.voice
        ? {
            kind: 'recording',
            startedAt: action.startedAt,
            bytes: 0,
            session: {
              ...session,
              manuallyScrolled: false,
              anchorTurnId: undefined,
            },
            capabilities,
          }
        : state;
    case 'RECORD_PROGRESS':
      return state.kind === 'recording'
        ? { ...state, bytes: action.bytes }
        : state;
    case 'TRANSCRIPT_SNAPSHOT':
      return state.kind === 'recording' || state.kind === 'stopping'
        ? {
            ...state,
            finalText: action.finalText,
            interimText: action.interimText,
          }
        : state;
    case 'RECORD_STOP_REQUESTED':
      return state.kind === 'recording'
        ? {
            kind: 'stopping',
            finalText: state.finalText,
            interimText: state.interimText,
            session,
            capabilities,
          }
        : state;
    case 'UPLOAD_STARTED':
      return state.kind === 'stopping' || state.kind === 'error'
        ? {
            kind: 'uploading',
            idempotencyKey: action.idempotencyKey,
            transcript:
              state.kind === 'stopping' ? snapshotText(state) : undefined,
            session,
            capabilities,
          }
        : state;
    case 'TURN_ACCEPTED':
      return state.kind === 'uploading'
        ? {
            kind: 'transcribing',
            turn: action.turn,
            transcript: state.transcript,
            session,
            capabilities,
          }
        : state;
    case 'STREAM_FINAL':
      if (state.kind !== 'stopping') return state;
      return stateForServerTurn(state, action.turn, action.result);
    case 'TURN_UPDATED':
      if (!hasActiveServerTurn(state)) return state;
      return stateForServerTurn(state, action.turn, action.result);
    case 'POLL_NOTICE':
      return state.kind === 'transcribing' ||
        state.kind === 'thinking' ||
        state.kind === 'review'
        ? { ...state, notice: action.message }
        : state;
    case 'CONFIRMATION_OPEN':
      return state.kind === 'review'
        ? { ...state, choiceOpen: true, choice: 'send', notice: undefined }
        : state;
    case 'CONFIRMATION_CLOSE':
      return state.kind === 'review'
        ? { ...state, choiceOpen: false, notice: undefined }
        : state;
    case 'CONFIRMATION_TOGGLE':
      return state.kind === 'review' && state.choiceOpen
        ? {
            ...state,
            choice: state.choice === 'send' ? 'discard' : 'send',
          }
        : state;
    case 'CONFIRMATION_FAILED':
      return state.kind === 'review'
        ? { ...state, notice: action.message }
        : state;
    case 'TURN_COMPLETED': {
      const turns = upsertConversationTurn(session.turns, {
        turnId: action.turnId,
        transcript: action.transcript,
        reply: action.reply || '(empty response)',
      });
      return {
        kind: 'ready',
        session: {
          ...session,
          turns,
          manuallyScrolled: false,
          anchorTurnId: action.turnId,
        },
        capabilities,
      };
    }
    case 'TURN_FAILED': {
      const turns = upsertConversationTurn(session.turns, {
        turnId: action.turnId,
        transcript: action.transcript,
        failure: action.message,
      });
      return {
        kind: 'ready',
        session: {
          ...session,
          turns,
          manuallyScrolled: false,
          anchorTurnId: action.turnId,
        },
        capabilities,
      };
    }
    case 'TURN_DISCARDED':
      return {
        kind: 'ready',
        session: {
          ...session,
          manuallyScrolled: false,
          anchorTurnId: undefined,
        },
        capabilities,
      };
    case 'SCROLLED':
      return {
        ...state,
        session: {
          ...session,
          scrollOffset: action.offset,
          manuallyScrolled: true,
        },
        capabilities,
      };
    case 'FAILED':
      return {
        kind: 'error',
        message: action.message,
        retryable: action.retryable,
        activeTurn: action.activeTurn,
        session,
        capabilities,
      };
  }
}

export function conversationEntries(state: AppState): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const turn of state.session.turns) {
    if (turn.transcript) {
      entries.push({
        id: `${turn.turnId}:you`,
        speaker: 'You',
        text: turn.transcript,
      });
    }
    if (turn.reply) {
      entries.push({
        id: `${turn.turnId}:reply`,
        speaker: 'NanoClaw',
        text: turn.reply,
      });
    } else if (turn.failure) {
      entries.push({
        id: `${turn.turnId}:failure`,
        speaker: 'Notice',
        text: turn.failure,
      });
    }
  }

  const active = activeTranscript(state);
  if (
    active?.text &&
    !state.session.turns.some((turn) => turn.turnId === active.turnId)
  ) {
    entries.push({
      id: `${active.turnId}:you`,
      speaker: 'You',
      text: active.text,
    });
  }
  return entries;
}

function stateForServerTurn(
  state: AppState,
  turn: ActiveTurn,
  result: ServerTurn,
): AppState {
  const transcript = result.transcript || currentTranscript(state);
  if (result.state === 'accepted' || result.state === 'transcribing') {
    return {
      kind: 'transcribing',
      turn,
      transcript,
      session: state.session,
      capabilities: state.capabilities,
    };
  }
  if (result.state === 'awaiting_confirmation') {
    return {
      kind: 'review',
      turn,
      transcript: transcript || '(no speech recognized)',
      choiceOpen: true,
      choice: 'send',
      session: { ...state.session, manuallyScrolled: false },
      capabilities: state.capabilities,
    };
  }
  if (
    result.state === 'dispatching' ||
    result.state === 'queued' ||
    result.state === 'running'
  ) {
    return {
      kind: 'thinking',
      turn,
      transcript,
      session: state.session,
      capabilities: state.capabilities,
    };
  }
  return state;
}

function hasActiveServerTurn(state: AppState): boolean {
  return (
    state.kind === 'transcribing' ||
    state.kind === 'thinking' ||
    state.kind === 'review' ||
    state.kind === 'uploading'
  );
}

function activeTranscript(
  state: AppState,
): { turnId: string; text?: string } | undefined {
  if (state.kind === 'recording' || state.kind === 'stopping') {
    return { turnId: 'draft', text: snapshotText(state) };
  }
  if (state.kind === 'uploading') {
    return { turnId: 'draft', text: state.transcript };
  }
  if (state.kind === 'submitting_text') {
    return { turnId: `text:${state.idempotencyKey}`, text: state.text };
  }
  if (
    state.kind === 'transcribing' ||
    state.kind === 'review' ||
    state.kind === 'thinking'
  ) {
    return { turnId: state.turn.id, text: state.transcript };
  }
  return undefined;
}

function currentTranscript(state: AppState): string | undefined {
  return activeTranscript(state)?.text;
}

function snapshotText(
  state: Extract<AppState, { kind: 'recording' | 'stopping' }>,
): string {
  return [state.finalText, state.interimText].filter(Boolean).join(' ').trim();
}

function upsertConversationTurn(
  turns: ConversationTurn[],
  next: ConversationTurn,
): ConversationTurn[] {
  return turns.filter((turn) => turn.turnId !== next.turnId).concat(next);
}
