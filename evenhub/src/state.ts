export type ServerTurnState =
  | 'accepted'
  | 'transcribing'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

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

export interface CompletedTurn {
  turnId: string;
  transcript?: string;
  pages: string[];
}

export interface SessionState {
  turns: CompletedTurn[];
  turn: number;
}

type AppViewState =
  | { kind: 'booting' }
  | { kind: 'pairing'; error?: string }
  | { kind: 'ready' }
  | { kind: 'recording'; startedAt: number; bytes: number }
  | { kind: 'stopping' }
  | { kind: 'uploading'; idempotencyKey: string }
  | {
      kind: 'transcribing';
      turn: ActiveTurn;
      transcript?: string;
      notice?: string;
    }
  | {
      kind: 'thinking';
      turn: ActiveTurn;
      transcript?: string;
      notice?: string;
    }
  | {
      kind: 'answer';
      turnId: string;
      transcript?: string;
      pages: string[];
      page: number;
    }
  | {
      kind: 'error';
      message: string;
      retryable: boolean;
      activeTurn?: ActiveTurn;
    };

export type AppState = AppViewState & { session: SessionState };

export type AppAction =
  | { type: 'RESTORED'; hasToken: boolean; activeTurn?: ActiveTurn }
  | { type: 'PAIR_FAILED'; message: string }
  | { type: 'PAIRED' }
  | { type: 'RECORD_STARTED'; startedAt: number }
  | { type: 'RECORD_PROGRESS'; bytes: number }
  | { type: 'RECORD_STOP_REQUESTED' }
  | { type: 'UPLOAD_STARTED'; idempotencyKey: string }
  | { type: 'TURN_ACCEPTED'; turn: ActiveTurn }
  | { type: 'TURN_UPDATED'; turn: ActiveTurn; result: ServerTurn }
  | { type: 'POLL_NOTICE'; message: string }
  | {
      type: 'TURN_COMPLETED';
      turnId: string;
      transcript?: string;
      pages: string[];
    }
  | {
      type: 'FAILED';
      message: string;
      retryable: boolean;
      activeTurn?: ActiveTurn;
    }
  | { type: 'PAGE_NEXT' }
  | { type: 'PAGE_PREVIOUS' }
  | { type: 'READY' }
  | { type: 'PAIRING_REQUIRED'; message?: string };

export const initialState: AppState = {
  kind: 'booting',
  session: { turns: [], turn: 0 },
};

export function reduceAppState(state: AppState, action: AppAction): AppState {
  const session = state.session;
  switch (action.type) {
    case 'RESTORED':
      if (!action.hasToken) return { kind: 'pairing', session };
      return action.activeTurn
        ? { kind: 'transcribing', turn: action.activeTurn, session }
        : { kind: 'ready', session };
    case 'PAIR_FAILED':
      return { kind: 'pairing', error: action.message, session };
    case 'PAIRED':
    case 'READY':
      return { kind: 'ready', session };
    case 'PAIRING_REQUIRED':
      return { kind: 'pairing', error: action.message, session };
    case 'RECORD_STARTED':
      return state.kind === 'ready'
        ? {
            kind: 'recording',
            startedAt: action.startedAt,
            bytes: 0,
            session,
          }
        : state;
    case 'RECORD_PROGRESS':
      return state.kind === 'recording'
        ? { ...state, bytes: action.bytes }
        : state;
    case 'RECORD_STOP_REQUESTED':
      return state.kind === 'recording' ? { kind: 'stopping', session } : state;
    case 'UPLOAD_STARTED':
      return state.kind === 'stopping' || state.kind === 'error'
        ? { kind: 'uploading', idempotencyKey: action.idempotencyKey, session }
        : state;
    case 'TURN_ACCEPTED':
      return state.kind === 'uploading'
        ? { kind: 'transcribing', turn: action.turn, session }
        : state;
    case 'TURN_UPDATED':
      if (
        state.kind !== 'transcribing' &&
        state.kind !== 'thinking' &&
        state.kind !== 'uploading'
      ) {
        return state;
      }
      if (
        action.result.state === 'accepted' ||
        action.result.state === 'transcribing'
      ) {
        return {
          kind: 'transcribing',
          turn: action.turn,
          transcript: action.result.transcript,
          notice:
            state.kind === 'transcribing' || state.kind === 'thinking'
              ? state.notice
              : undefined,
          session,
        };
      }
      if (
        action.result.state === 'dispatching' ||
        action.result.state === 'queued' ||
        action.result.state === 'running'
      ) {
        return {
          kind: 'thinking',
          turn: action.turn,
          transcript: action.result.transcript,
          notice:
            state.kind === 'transcribing' || state.kind === 'thinking'
              ? state.notice
              : undefined,
          session,
        };
      }
      return state;
    case 'POLL_NOTICE':
      return state.kind === 'transcribing' || state.kind === 'thinking'
        ? { ...state, notice: action.message }
        : state;
    case 'TURN_COMPLETED': {
      const pages =
        action.pages.length > 0 ? action.pages : ['(empty response)'];
      const turns = session.turns
        .filter((turn) => turn.turnId !== action.turnId)
        .concat({
          turnId: action.turnId,
          transcript: action.transcript,
          pages,
        });
      return answerAt({ turns, turn: turns.length - 1 }, turns.length - 1, 0);
    }
    case 'FAILED':
      return {
        kind: 'error',
        message: action.message,
        retryable: action.retryable,
        activeTurn: action.activeTurn,
        session,
      };
    case 'PAGE_NEXT':
      return state.kind === 'answer' ? moveAnswer(state, 1) : state;
    case 'PAGE_PREVIOUS':
      return state.kind === 'answer' ? moveAnswer(state, -1) : state;
  }
}

function moveAnswer(
  state: Extract<AppState, { kind: 'answer' }>,
  direction: -1 | 1,
): AppState {
  if (direction === 1) {
    if (state.page < state.pages.length - 1) {
      return { ...state, page: state.page + 1 };
    }
    if (state.session.turn < state.session.turns.length - 1) {
      const turn = state.session.turn + 1;
      return answerAt(state.session, turn, 0);
    }
    return state;
  }

  if (state.page > 0) return { ...state, page: state.page - 1 };
  if (state.session.turn > 0) {
    const turn = state.session.turn - 1;
    const previous = state.session.turns[turn];
    return answerAt(state.session, turn, previous.pages.length - 1);
  }
  return state;
}

function answerAt(session: SessionState, turn: number, page: number): AppState {
  const selected = session.turns[turn];
  return {
    kind: 'answer',
    turnId: selected.turnId,
    transcript: selected.transcript,
    pages: selected.pages,
    page,
    session: { ...session, turn },
  };
}
