export type ServerTurnState =
  | 'accepted'
  | 'transcribing'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export interface ServerTurn {
  id: string;
  state: ServerTurnState;
  transcript?: string;
  answer?: string;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ActiveTurn {
  id: string;
  idempotencyKey: string;
}

export type AppState =
  | { kind: 'booting' }
  | { kind: 'pairing'; error?: string }
  | { kind: 'ready' }
  | { kind: 'recording'; startedAt: number; bytes: number }
  | { kind: 'uploading'; idempotencyKey: string }
  | { kind: 'transcribing'; turn: ActiveTurn; transcript?: string }
  | { kind: 'thinking'; turn: ActiveTurn; transcript?: string }
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

export type AppAction =
  | { type: 'RESTORED'; hasToken: boolean; activeTurn?: ActiveTurn }
  | { type: 'PAIR_FAILED'; message: string }
  | { type: 'PAIRED' }
  | { type: 'RECORD_STARTED'; startedAt: number }
  | { type: 'RECORD_PROGRESS'; bytes: number }
  | { type: 'UPLOAD_STARTED'; idempotencyKey: string }
  | { type: 'TURN_ACCEPTED'; turn: ActiveTurn }
  | { type: 'TURN_UPDATED'; turn: ActiveTurn; result: ServerTurn }
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

export const initialState: AppState = { kind: 'booting' };

export function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'RESTORED':
      if (!action.hasToken) return { kind: 'pairing' };
      return action.activeTurn
        ? { kind: 'transcribing', turn: action.activeTurn }
        : { kind: 'ready' };
    case 'PAIR_FAILED':
      return { kind: 'pairing', error: action.message };
    case 'PAIRED':
    case 'READY':
      return { kind: 'ready' };
    case 'PAIRING_REQUIRED':
      return { kind: 'pairing', error: action.message };
    case 'RECORD_STARTED':
      return state.kind === 'ready'
        ? { kind: 'recording', startedAt: action.startedAt, bytes: 0 }
        : state;
    case 'RECORD_PROGRESS':
      return state.kind === 'recording'
        ? { ...state, bytes: action.bytes }
        : state;
    case 'UPLOAD_STARTED':
      return state.kind === 'recording' || state.kind === 'error'
        ? { kind: 'uploading', idempotencyKey: action.idempotencyKey }
        : state;
    case 'TURN_ACCEPTED':
      return state.kind === 'uploading'
        ? { kind: 'transcribing', turn: action.turn }
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
        };
      }
      return state;
    case 'TURN_COMPLETED':
      return {
        kind: 'answer',
        turnId: action.turnId,
        transcript: action.transcript,
        pages: action.pages.length > 0 ? action.pages : ['(empty response)'],
        page: 0,
      };
    case 'FAILED':
      return {
        kind: 'error',
        message: action.message,
        retryable: action.retryable,
        activeTurn: action.activeTurn,
      };
    case 'PAGE_NEXT':
      return state.kind === 'answer'
        ? { ...state, page: Math.min(state.page + 1, state.pages.length - 1) }
        : state;
    case 'PAGE_PREVIOUS':
      return state.kind === 'answer'
        ? { ...state, page: Math.max(state.page - 1, 0) }
        : state;
  }
}
