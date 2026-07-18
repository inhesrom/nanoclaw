export const EVEN_TURN_STATES = [
  'accepted',
  'transcribing',
  'awaiting_confirmation',
  'dispatching',
  'queued',
  'running',
  'completed',
  'failed',
  'discarded',
] as const;

export type EvenTurnState = (typeof EVEN_TURN_STATES)[number];

export interface EvenDevice {
  id: string;
  name: string;
  token_sha256: string;
  created_at: string;
  last_used_at: string;
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
  request_sha256: string;
  audio_path: string;
  audio_duration_ms: number;
  state: EvenTurnState;
  confirmation_decision: 'send' | 'discard' | null;
  transcript: string | null;
  whatsapp_message_id: string | null;
  answer: string | null;
  error_code: string | null;
  error_message: string | null;
  stt_attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PublicEvenTurn {
  turnId: string;
  state: EvenTurnState;
  transcript?: string;
  answer?: string;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pollAfterMs: number;
}

const RETRYABLE_EVEN_TURN_ERRORS = new Set([
  'stt_unavailable',
  'whatsapp_unavailable',
  'agent_failed',
]);

export function toPublicEvenTurn(turn: EvenTurn): PublicEvenTurn {
  return {
    turnId: turn.id,
    state: turn.state,
    ...(turn.transcript ? { transcript: turn.transcript } : {}),
    ...(turn.answer ? { answer: turn.answer } : {}),
    ...(turn.error_code && turn.error_message
      ? {
          error: {
            code: turn.error_code,
            message: turn.error_message,
            retryable: RETRYABLE_EVEN_TURN_ERRORS.has(turn.error_code),
          },
        }
      : {}),
    createdAt: turn.created_at,
    updatedAt: turn.updated_at,
    ...(turn.completed_at ? { completedAt: turn.completed_at } : {}),
    pollAfterMs: 500,
  };
}
