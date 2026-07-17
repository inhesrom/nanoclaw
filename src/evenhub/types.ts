export const EVEN_TURN_STATES = [
  'accepted',
  'transcribing',
  'dispatching',
  'queued',
  'running',
  'completed',
  'failed',
] as const;

export type EvenTurnState = (typeof EVEN_TURN_STATES)[number];

export interface EvenDevice {
  id: string;
  name: string;
  token_sha256: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface EvenPairingCode {
  code_sha256: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface EvenPairingAttempt {
  address: string;
  failures: number;
  locked_until: string | null;
  updated_at: string;
}

export interface EvenTurn {
  id: string;
  device_id: string;
  idempotency_key: string;
  audio_sha256: string;
  audio_path: string;
  duration_ms: number;
  state: EvenTurnState;
  transcript: string | null;
  answer: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PublicEvenTurn {
  id: string;
  state: EvenTurnState;
  transcript?: string;
  answer?: string;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export function toPublicEvenTurn(turn: EvenTurn): PublicEvenTurn {
  return {
    id: turn.id,
    state: turn.state,
    ...(turn.transcript ? { transcript: turn.transcript } : {}),
    ...(turn.answer ? { answer: turn.answer } : {}),
    ...(turn.error_code && turn.error_message
      ? { error: { code: turn.error_code, message: turn.error_message } }
      : {}),
    createdAt: turn.created_at,
    updatedAt: turn.updated_at,
    ...(turn.completed_at ? { completedAt: turn.completed_at } : {}),
  };
}
