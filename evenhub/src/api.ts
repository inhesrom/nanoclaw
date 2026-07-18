import type { ServerTurn } from './state';

export const TAILSCALE_UNAVAILABLE_MESSAGE = 'Connect Tailscale and retry.';
export const EVENHUB_PROTOCOL_VERSION = 2;

export class EvenHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface PairResult {
  deviceId: string;
  token: string;
}

export interface CapabilityResult {
  protocolVersion: 2;
  capabilities: { voice: boolean; text: boolean };
  unavailable: { voice: string[]; text: string[] };
}

export interface SttSession {
  sessionId: string;
  ticket: string;
  expiresAt: string;
  protocolVersion: 2;
  audio: {
    encoding: 's16le';
    sampleRate: 16000;
    channels: 1;
    maxDurationMs: 30000;
    maxBytes: 960000;
  };
}

export interface TranscriptSnapshot {
  finalText: string;
  interimText: string;
}

export interface LiveTurn {
  push(pcm: Uint8Array): void;
  finish(pcm: Uint8Array, durationMs: number): Promise<ServerTurn>;
  abort(): void;
}

export interface EvenHubApiPort {
  checkReady(): Promise<void>;
  getCapabilities(): Promise<CapabilityResult>;
  pair(code: string, deviceName: string): Promise<PairResult>;
  submitTurn(
    token: string,
    pcm: Uint8Array,
    durationMs: number,
    idempotencyKey: string,
  ): Promise<ServerTurn>;
  submitTextTurn(
    token: string,
    text: string,
    idempotencyKey: string,
  ): Promise<ServerTurn>;
  startLiveTurn?(
    token: string,
    idempotencyKey: string,
    onSnapshot: (snapshot: TranscriptSnapshot) => void,
  ): LiveTurn;
  getTurn(token: string, turnId: string): Promise<ServerTurn>;
  confirmTurn(
    token: string,
    turnId: string,
    decision: 'send' | 'discard',
  ): Promise<ServerTurn>;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; retryable?: boolean };
}

function protocolHeaders(): Record<string, string> {
  return { 'X-EvenHub-Protocol-Version': String(EVENHUB_PROTOCOL_VERSION) };
}

export class EvenHubApi implements EvenHubApiPort {
  constructor(private readonly origin: string) {}

  async checkReady(): Promise<void> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 5_000);
    try {
      await this.request('/api/even/v1/readyz', {
        method: 'GET',
        headers: protocolHeaders(),
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async getCapabilities(): Promise<CapabilityResult> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 5_000);
    try {
      return await this.request<CapabilityResult>('/api/even/v1/capabilities', {
        method: 'GET',
        headers: protocolHeaders(),
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

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
        ...protocolHeaders(),
      },
      body: audio,
    });
  }

  submitTextTurn(
    token: string,
    text: string,
    idempotencyKey: string,
  ): Promise<ServerTurn> {
    return this.request<ServerTurn>('/api/even/v1/text-turns', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...protocolHeaders(),
      },
      body: JSON.stringify({ idempotencyKey, text }),
    });
  }

  getTurn(token: string, turnId: string): Promise<ServerTurn> {
    return this.request<ServerTurn>(`/api/even/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${token}`, ...protocolHeaders() },
    });
  }

  confirmTurn(
    token: string,
    turnId: string,
    decision: 'send' | 'discard',
  ): Promise<ServerTurn> {
    return this.request<ServerTurn>(
      `/api/even/v1/turns/${turnId}/confirmation`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...protocolHeaders(),
        },
        body: JSON.stringify({ decision }),
      },
    );
  }

  startLiveTurn(
    token: string,
    idempotencyKey: string,
    onSnapshot: (snapshot: TranscriptSnapshot) => void,
  ): LiveTurn {
    return new EvenHubLiveTurn(
      this.createSttSession(token, idempotencyKey),
      this.origin,
      onSnapshot,
    );
  }

  private createSttSession(
    token: string,
    idempotencyKey: string,
  ): Promise<SttSession> {
    return this.request<SttSession>('/api/even/v1/stt-sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...protocolHeaders(),
      },
      body: JSON.stringify({ idempotencyKey }),
    });
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.origin), init);
    } catch {
      throw new EvenHubApiError(
        0,
        'tailscale_unavailable',
        TAILSCALE_UNAVAILABLE_MESSAGE,
        true,
      );
    }
    const body = (await response.json().catch(() => ({}))) as T & ErrorEnvelope;
    if (!response.ok) {
      throw new EvenHubApiError(
        response.status,
        body.error?.code || 'request_failed',
        body.error?.message || `Request failed with status ${response.status}`,
        body.error?.retryable ?? response.status >= 500,
      );
    }
    return body;
  }
}

class EvenHubLiveTurn implements LiveTurn {
  private static readonly FINAL_TIMEOUT_MS = 10_000;

  private readonly queued: Uint8Array[] = [];
  private socket?: WebSocket;
  private sequence = 0;
  private ready = false;
  private failed?: Error;
  private finishTimeout?: number;
  private final?: {
    resolve: (turn: ServerTurn) => void;
    reject: (error: Error) => void;
  };

  constructor(
    session: Promise<SttSession>,
    private readonly origin: string,
    private readonly onSnapshot: (snapshot: TranscriptSnapshot) => void,
  ) {
    void session
      .then((value) => this.connect(value))
      .catch((error) => {
        this.fail(asError(error));
      });
  }

  push(pcm: Uint8Array): void {
    if (this.failed) return;
    const copy = new Uint8Array(pcm);
    if (!this.ready) {
      const buffered = this.queued.reduce(
        (total, chunk) => total + chunk.byteLength,
        copy.byteLength,
      );
      if (buffered > 256 * 1024) {
        this.fail(new Error('Live transcription could not keep up'));
        return;
      }
      this.queued.push(copy);
      return;
    }
    this.sendPcm(copy);
  }

  async finish(pcm: Uint8Array, durationMs: number): Promise<ServerTurn> {
    if (this.failed) throw this.failed;
    const sha256 = await sha256Hex(pcm);
    if (this.failed) throw this.failed;
    return new Promise<ServerTurn>((resolve, reject) => {
      this.final = { resolve, reject };
      this.finishTimeout = window.setTimeout(
        () =>
          this.fail(
            new Error('Live transcription did not return a final response'),
          ),
        EvenHubLiveTurn.FINAL_TIMEOUT_MS,
      );
      const sendFinish = () => {
        if (this.failed) {
          reject(this.failed);
          return;
        }
        if (!this.ready) {
          window.setTimeout(sendFinish, 10);
          return;
        }
        this.sendJson({
          type: 'finish',
          nextSequence: this.sequence,
          durationMs,
          sha256,
        });
      };
      sendFinish();
    });
  }

  abort(): void {
    this.fail(new Error('Live transcription was cancelled'));
  }

  private connect(session: SttSession): void {
    if (this.failed) return;
    const url = new URL('/api/even/v1/stt-stream', this.origin);
    url.protocol = 'wss:';
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.sendJson({
        type: 'start',
        version: EVENHUB_PROTOCOL_VERSION,
        session: session.sessionId,
        ticket: session.ticket,
        format: { encoding: 's16le', sampleRate: 16_000, channels: 1 },
      });
    });
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => {
      this.fail(new Error('Live transcription connection failed'));
    });
    socket.addEventListener('close', () => {
      if (this.final) this.fail(new Error('Live transcription closed early'));
    });
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.fail(new Error('Live transcription returned invalid data'));
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.fail(new Error('Live transcription returned invalid data'));
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      for (const chunk of this.queued.splice(0)) this.sendPcm(chunk);
      return;
    }
    if (
      message.type === 'snapshot' &&
      typeof message.finalText === 'string' &&
      typeof message.interimText === 'string'
    ) {
      this.onSnapshot({
        finalText: message.finalText,
        interimText: message.interimText,
      });
      return;
    }
    if (message.type === 'final') {
      const { type: _type, ...turn } = message;
      this.clearFinishTimeout();
      this.final?.resolve(turn as unknown as ServerTurn);
      this.final = undefined;
      this.socket?.close();
      return;
    }
    if (message.type === 'error') {
      this.fail(
        new EvenHubApiError(
          0,
          typeof message.code === 'string' ? message.code : 'stream_failed',
          'Live transcription failed',
          message.retryable === true,
        ),
      );
    }
  }

  private sendPcm(pcm: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.fail(new Error('Live transcription is not connected'));
      return;
    }
    if (this.socket.bufferedAmount > 256 * 1024) {
      this.fail(new Error('Live transcription could not keep up'));
      return;
    }
    const frame = new ArrayBuffer(pcm.byteLength + 4);
    const view = new DataView(frame);
    view.setUint32(0, this.sequence, false);
    new Uint8Array(frame, 4).set(pcm);
    this.sequence += 1;
    this.socket.send(frame);
  }

  private sendJson(value: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.fail(new Error('Live transcription is not connected'));
      return;
    }
    this.socket.send(JSON.stringify(value));
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    this.clearFinishTimeout();
    this.final?.reject(error);
    this.final = undefined;
    this.queued.length = 0;
    this.socket?.close();
  }

  private clearFinishTimeout(): void {
    if (this.finishTimeout === undefined) return;
    window.clearTimeout(this.finishTimeout);
    this.finishTimeout = undefined;
  }
}

async function sha256Hex(pcm: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(pcm);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Live transcription failed');
}
