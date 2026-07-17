import type { ServerTurn } from './state';

export class EvenHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PairResult {
  deviceId: string;
  token: string;
}

export interface EvenHubApiPort {
  pair(code: string, deviceName: string): Promise<PairResult>;
  submitTurn(
    token: string,
    pcm: Uint8Array,
    durationMs: number,
    idempotencyKey: string,
  ): Promise<ServerTurn>;
  getTurn(token: string, turnId: string): Promise<ServerTurn>;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class EvenHubApi implements EvenHubApiPort {
  constructor(private readonly origin: string) {}

  pair(code: string, deviceName: string): Promise<PairResult> {
    return this.request<PairResult>('/api/even/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    });
  }

  submitTurn(
    token: string,
    pcm: Uint8Array,
    durationMs: number,
    idempotencyKey: string,
  ): Promise<ServerTurn> {
    const audio = new ArrayBuffer(pcm.byteLength);
    new Uint8Array(audio).set(pcm);
    return this.request<ServerTurn>('/api/even/v1/turns', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': idempotencyKey,
        'X-Audio-Duration-Ms': String(durationMs),
      },
      body: audio,
    });
  }

  getTurn(token: string, turnId: string): Promise<ServerTurn> {
    return this.request<ServerTurn>(`/api/even/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const response = await fetch(new URL(pathname, this.origin), init);
    const body = (await response.json().catch(() => ({}))) as T & ErrorEnvelope;
    if (!response.ok) {
      throw new EvenHubApiError(
        response.status,
        body.error?.code || 'request_failed',
        body.error?.message || `Request failed with status ${response.status}`,
      );
    }
    return body;
  }
}
