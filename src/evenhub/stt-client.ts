import WebSocket from 'ws';

export interface SttTranscriber {
  transcribe(pcm: Uint8Array): Promise<string>;
}

export interface SttSnapshot {
  finalText: string;
  interimText: string;
}

export interface SttStreamResult {
  text: string;
  processingMs: number;
}

export interface SttStream {
  addAudio(pcm: Uint8Array): void;
  finish(): Promise<SttStreamResult>;
  close(): void;
}

export interface SttStreamingProvider {
  connect(onSnapshot: (snapshot: SttSnapshot) => void): Promise<SttStream>;
}

export class SttClientError extends Error {
  constructor(
    readonly code: 'invalid_audio' | 'stt_unavailable',
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SttClientError';
  }
}

export interface MoonshineClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  WebSocket?: typeof WebSocket;
}

interface PendingStream {
  resolve: (result: SttStreamResult) => void;
  reject: (error: Error) => void;
}

/** Client for the fixed, loopback-only Moonshine service boundary. */
export class MoonshineClient implements SttTranscriber, SttStreamingProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly healthEndpoint: string;
  private readonly streamEndpoint: string;

  constructor(
    private readonly endpoint: string,
    options: MoonshineClientOptions = {},
  ) {
    const endpointUrl = requireLoopbackUrl(endpoint);
    this.healthEndpoint = new URL('/healthz', endpointUrl).toString();
    const streamUrl = new URL('/v1/stream', endpointUrl);
    streamUrl.protocol = 'ws:';
    this.streamEndpoint = streamUrl.toString();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.WebSocketImpl = options.WebSocket ?? WebSocket;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.healthEndpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2_000)),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { status?: unknown };
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  async transcribe(pcm: Uint8Array): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/L16;rate=16000;channels=1' },
        body: copyArrayBuffer(pcm),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      const retryable = response.status >= 500;
      throw new SttClientError(
        retryable ? 'stt_unavailable' : 'invalid_audio',
        retryable,
        retryable
          ? 'Local speech recognition is unavailable'
          : 'Local speech recognition rejected the recording',
        response.status,
      );
    }
    try {
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload.text !== 'string') throw new Error('missing text');
      return normalizeTranscript(payload.text);
    } catch {
      throw unavailable(response.status);
    }
  }

  connect(onSnapshot: (snapshot: SttSnapshot) => void): Promise<SttStream> {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.streamEndpoint, {
        perMessageDeflate: false,
        maxPayload: 1_048_576,
      });
      let ready = false;
      let settled = false;
      let pending: PendingStream | undefined;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(unavailable());
      }, 5_000);
      timer.unref();

      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'start',
            version: 1,
            format: { encoding: 's16le', sampleRate: 16_000, channels: 1 },
          }),
        );
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return fail(unavailable());
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          fail(unavailable());
          return;
        }
        if (message.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve({
            addAudio(pcm) {
              if (socket.readyState !== WebSocket.OPEN) throw unavailable();
              if (socket.bufferedAmount > 256 * 1024) {
                throw new SttClientError(
                  'stt_unavailable',
                  true,
                  'Local speech recognition is backpressured',
                );
              }
              socket.send(copyArrayBuffer(pcm), { binary: true });
            },
            finish() {
              if (pending) return Promise.reject(unavailable());
              socket.send(JSON.stringify({ type: 'finish' }));
              return new Promise<SttStreamResult>((nextResolve, nextReject) => {
                pending = { resolve: nextResolve, reject: nextReject };
              });
            },
            close() {
              socket.close();
            },
          });
          return;
        }
        if (message.type === 'snapshot') {
          if (
            typeof message.finalText === 'string' &&
            typeof message.interimText === 'string'
          ) {
            onSnapshot({
              finalText: message.finalText,
              interimText: message.interimText,
            });
          }
          return;
        }
        if (
          message.type === 'final' &&
          typeof message.text === 'string' &&
          typeof message.processingMs === 'number'
        ) {
          settled = true;
          pending?.resolve({
            text: normalizeTranscript(message.text),
            processingMs: message.processingMs,
          });
          pending = undefined;
          socket.close();
          return;
        }
        if (message.type === 'error') fail(unavailable());
      });
      socket.on('error', () => fail(unavailable()));
      socket.on('close', () => {
        clearTimeout(timer);
        if (!ready) reject(unavailable());
        if (!settled) pending?.reject(unavailable());
      });

      function fail(error: SttClientError): void {
        clearTimeout(timer);
        if (!ready) reject(error);
        pending?.reject(error);
        pending = undefined;
        socket.terminate();
      }
    });
  }
}

export function normalizeTranscript(transcript: string): string {
  return transcript.trim().replace(/\s+/gu, ' ');
}

function requireLoopbackUrl(endpoint: string): URL {
  const value = new URL(endpoint);
  if (
    value.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) ||
    value.username ||
    value.password
  ) {
    throw new Error('STT endpoint must be an unauthenticated loopback URL');
  }
  return value;
}

function unavailable(status?: number): SttClientError {
  return new SttClientError(
    'stt_unavailable',
    true,
    'Local speech recognition is unavailable',
    status,
  );
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
