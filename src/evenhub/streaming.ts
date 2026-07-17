import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import type http from 'http';
import path from 'path';
import type { Duplex } from 'stream';

import { getActiveEvenDevices } from '../db.js';
import { logger as defaultLogger } from '../logger.js';
import type { EvenDevice, PublicEvenTurn } from './types.js';
import { toPublicEvenTurn } from './types.js';
import type {
  SttSnapshot,
  SttStream,
  SttStreamingProvider,
} from './stt-client.js';
import { EvenTurnFinalizer, TurnFinalizationError } from './turn-finalizer.js';
import { createUuidV7, isUuidV4 } from './uuid.js';
import { WebSocket, WebSocketServer } from 'ws';

export const EVEN_STREAM_PATH = '/api/even/v1/stt-stream';
export const EVEN_STREAM_PROTOCOL_VERSION = 1;
export const EVEN_STREAM_TICKET_TTL_MS = 60_000;
export const EVEN_STREAM_AUTH_TIMEOUT_MS = 5_000;
export const EVEN_STREAM_MAX_BUFFERED_BYTES = 256 * 1024;
export const EVEN_STREAM_MAX_AUDIO_BYTES = 960_000;
export const EVEN_STREAM_MAX_DURATION_MS = 30_000;

interface StreamLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

interface TicketRecord {
  sessionId: string;
  deviceId: string;
  idempotencyKey: string;
  ticketSha256: string;
  expiresAt: number;
  consumed: boolean;
  expiryTimer: NodeJS.Timeout;
}

export interface StreamingSessionTicket {
  sessionId: string;
  ticket: string;
  expiresAt: string;
  protocolVersion: 1;
  audio: {
    encoding: 's16le';
    sampleRate: 16000;
    channels: 1;
    maxDurationMs: 30000;
    maxBytes: 960000;
  };
}

export class StreamProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly closeCode = 1008,
  ) {
    super('Streaming session rejected');
    this.name = 'StreamProtocolError';
  }
}

export class EvenStreamTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = EVEN_STREAM_TICKET_TTL_MS,
  ) {}

  create(device: EvenDevice, idempotencyKey: string): StreamingSessionTicket {
    if (!isUuidV4(idempotencyKey)) {
      throw new StreamProtocolError('invalid_idempotency_key', false);
    }
    const sessionId = createUuidV7();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    const expiryTimer = setTimeout(
      () => {
        this.tickets.delete(sessionId);
      },
      Math.max(0, expiresAt - this.now()),
    );
    expiryTimer.unref();
    this.tickets.set(sessionId, {
      sessionId,
      deviceId: device.id,
      idempotencyKey,
      ticketSha256: digest(ticket),
      expiresAt,
      consumed: false,
      expiryTimer,
    });
    return {
      sessionId,
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
      protocolVersion: 1,
      audio: {
        encoding: 's16le',
        sampleRate: 16_000,
        channels: 1,
        maxDurationMs: 30_000,
        maxBytes: 960_000,
      },
    };
  }

  consume(sessionId: string, ticket: string): TicketRecord {
    const record = this.tickets.get(sessionId);
    if (!record || record.expiresAt <= this.now()) {
      if (record) clearTimeout(record.expiryTimer);
      this.tickets.delete(sessionId);
      throw new StreamProtocolError('ticket_expired', true);
    }
    const candidate = digest(ticket);
    if (!hashEquals(record.ticketSha256, candidate)) {
      throw new StreamProtocolError('invalid_ticket', false);
    }
    if (record.consumed) {
      throw new StreamProtocolError('ticket_replayed', false);
    }
    record.consumed = true;
    return record;
  }

  revokeDevice(deviceId: string): void {
    for (const [sessionId, ticket] of this.tickets) {
      if (ticket.deviceId !== deviceId) continue;
      clearTimeout(ticket.expiryTimer);
      this.tickets.delete(sessionId);
    }
  }
}

export interface EvenHubStreamingOptions {
  audioDir: string;
  publicOrigin: string;
  stt: SttStreamingProvider;
  finalizer: EvenTurnFinalizer;
  tickets?: EvenStreamTicketStore;
  logger?: StreamLogger;
  now?: () => number;
}

interface StartMessage {
  type: 'start';
  version: 1;
  session: string;
  ticket: string;
  format: { encoding: 's16le'; sampleRate: 16000; channels: 1 };
}

interface FinishMessage {
  type: 'finish';
  nextSequence: number;
  durationMs: number;
  sha256: string;
}

export class EvenHubStreamingGateway {
  readonly tickets: EvenStreamTicketStore;
  private readonly logger: StreamLogger;
  private readonly now: () => number;
  private readonly sockets = new Set<WebSocket>();
  private readonly activeDevices = new Set<string>();
  private readonly websocket = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: EVEN_STREAM_MAX_AUDIO_BYTES + 4,
  });

  constructor(private readonly options: EvenHubStreamingOptions) {
    this.tickets = options.tickets ?? new EvenStreamTicketStore();
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
    this.websocket.on('connection', (socket) => this.acceptSocket(socket));
  }

  createSession(
    device: EvenDevice,
    idempotencyKey: string,
  ): StreamingSessionTicket {
    return this.tickets.create(device, idempotencyKey);
  }

  handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (
      pathname !== EVEN_STREAM_PATH ||
      !isAllowedWebSocketOrigin(
        request.headers.origin,
        this.options.publicOrigin,
      )
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.websocket.handleUpgrade(request, socket, head, (client) => {
      this.websocket.emit('connection', client, request);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close(1001);
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
  }

  private acceptSocket(socket: WebSocket): void {
    this.sockets.add(socket);
    let device: EvenDevice | undefined;
    let stream: SttStream | undefined;
    let partPath: string | undefined;
    let partFile: number | undefined;
    let bytes = 0;
    let sequence = 0;
    let authenticated = false;
    let finished = false;
    let committed = false;
    let closed = false;
    let idempotencyKey = '';
    const hash = createHash('sha256');
    let snapshotTimer: NodeJS.Timeout | undefined;
    let pendingSnapshot: SttSnapshot | undefined;
    let lastSnapshotAt = -Infinity;
    let chain = Promise.resolve();

    const authTimer = setTimeout(() => {
      reject(new StreamProtocolError('authentication_timeout', true));
    }, EVEN_STREAM_AUTH_TIMEOUT_MS);
    authTimer.unref();

    socket.on('message', (data, isBinary) => {
      chain = chain
        .then(() => handleMessage(data, isBinary))
        .catch((error: unknown) => {
          reject(asProtocolError(error));
        });
    });
    socket.on('error', () => cleanup());
    socket.on('close', () => cleanup());

    const handleMessage = async (
      data: Buffer | ArrayBuffer | Buffer[],
      isBinary: boolean,
    ): Promise<void> => {
      if (!authenticated) {
        if (isBinary) throw new StreamProtocolError('start_required', false);
        const start = parseJson(data) as Partial<StartMessage>;
        if (!validStart(start)) {
          throw new StreamProtocolError('invalid_start', false);
        }
        const ticket = this.tickets.consume(start.session, start.ticket);
        device = getActiveEvenDevices().find(
          (candidate) => candidate.id === ticket.deviceId,
        );
        if (!device) throw new StreamProtocolError('ticket_revoked', false);
        if (this.activeDevices.has(device.id) || this.activeDevices.size >= 2) {
          throw new StreamProtocolError('stream_limit', true, 1013);
        }
        authenticated = true;
        idempotencyKey = ticket.idempotencyKey;
        this.activeDevices.add(device.id);
        clearTimeout(authTimer);
        fs.mkdirSync(this.options.audioDir, {
          recursive: true,
          mode: 0o700,
        });
        partPath = path.join(this.options.audioDir, `.${start.session}.part`);
        partFile = fs.openSync(partPath, 'wx', 0o600);
        stream = await this.options.stt.connect(queueSnapshot);
        send({ type: 'ready', version: 1 });
        return;
      }

      if (finished) throw new StreamProtocolError('stream_finished', false);
      if (isBinary) {
        const frame = toBuffer(data);
        if (frame.byteLength < 6 || (frame.byteLength - 4) % 2 !== 0) {
          throw new StreamProtocolError('invalid_audio_frame', false);
        }
        const receivedSequence = frame.readUInt32BE(0);
        if (receivedSequence !== sequence) {
          throw new StreamProtocolError('sequence_mismatch', false);
        }
        const pcm = frame.subarray(4);
        if (bytes + pcm.byteLength > EVEN_STREAM_MAX_AUDIO_BYTES) {
          throw new StreamProtocolError('audio_too_large', false, 1009);
        }
        fs.writeSync(partFile!, pcm);
        hash.update(pcm);
        bytes += pcm.byteLength;
        sequence += 1;
        stream!.addAudio(pcm);
        return;
      }

      const finish = parseJson(data) as Partial<FinishMessage>;
      if (!validFinish(finish)) {
        throw new StreamProtocolError('invalid_finish', false);
      }
      finished = true;
      if (finish.nextSequence !== sequence) {
        throw new StreamProtocolError('sequence_mismatch', false);
      }
      fs.fsyncSync(partFile!);
      fs.closeSync(partFile!);
      partFile = undefined;
      const actualHash = hash.digest('hex');
      if (!hashEquals(actualHash, finish.sha256)) {
        throw new StreamProtocolError('audio_hash_mismatch', false);
      }
      if (
        finish.durationMs < 250 ||
        finish.durationMs > EVEN_STREAM_MAX_DURATION_MS ||
        bytes === 0 ||
        Math.abs(bytes - finish.durationMs * 32) > 640
      ) {
        throw new StreamProtocolError('audio_duration_mismatch', false);
      }

      const inferenceStartedAt = this.now();
      const result = await stream!.finish();
      const accepted = this.options.finalizer.finalizeStreaming(
        device!,
        idempotencyKey,
        {
          sha256: actualHash,
          size: bytes,
          tempPath: partPath!,
          durationMs: finish.durationMs,
        },
        result.text,
      );
      committed = true;
      partPath = undefined;
      this.logger.info(
        {
          turn_id: accepted.turn.id,
          state: accepted.turn.state,
          model_processing_ms: result.processingMs,
          finish_elapsed_ms: this.now() - inferenceStartedAt,
          idempotency_replayed: !accepted.created,
        },
        'even.stream.finalized',
      );
      send({ type: 'final', ...toPublicEvenTurn(accepted.turn) });
      socket.close(1000);
    };

    const queueSnapshot = (snapshot: SttSnapshot): void => {
      if (closed || finished) return;
      pendingSnapshot = snapshot;
      const elapsed = this.now() - lastSnapshotAt;
      if (elapsed >= 500) {
        flushSnapshot();
        return;
      }
      if (snapshotTimer) return;
      snapshotTimer = setTimeout(flushSnapshot, 500 - elapsed);
      snapshotTimer.unref();
    };

    const flushSnapshot = (): void => {
      snapshotTimer = undefined;
      if (!pendingSnapshot || closed || finished) return;
      const snapshot = pendingSnapshot;
      pendingSnapshot = undefined;
      lastSnapshotAt = this.now();
      send({ type: 'snapshot', ...snapshot });
    };

    const send = (message: StreamServerMessage): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > EVEN_STREAM_MAX_BUFFERED_BYTES) {
        throw new StreamProtocolError('slow_consumer', true, 1013);
      }
      socket.send(JSON.stringify(message));
    };

    const reject = (error: StreamProtocolError): void => {
      if (closed) return;
      this.logger.warn(
        {
          error_code: error.code,
          authenticated,
          committed,
          audio_bytes: bytes,
        },
        'even.stream.rejected',
      );
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: error.code,
            retryable: error.retryable,
            message: 'Streaming session rejected',
          }),
          () => socket.close(error.closeCode),
        );
      } else {
        socket.terminate();
      }
      cleanup();
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      if (snapshotTimer) clearTimeout(snapshotTimer);
      if (partFile !== undefined) {
        try {
          fs.closeSync(partFile);
        } catch {
          // Best-effort cleanup continues below.
        }
      }
      if (!committed && partPath) fs.rmSync(partPath, { force: true });
      stream?.close();
      if (device) this.activeDevices.delete(device.id);
      this.sockets.delete(socket);
    };
  }
}

function isAllowedWebSocketOrigin(
  origin: string | undefined,
  publicOrigin: string,
): boolean {
  if (origin === publicOrigin) return true;
  if (!origin) return false;
  try {
    const candidate = new URL(origin);
    const port = Number(candidate.port);
    return (
      candidate.origin === origin &&
      candidate.protocol === 'http:' &&
      candidate.hostname === '127.0.0.1' &&
      Number.isSafeInteger(port) &&
      port >= 49_152 &&
      port <= 65_535
    );
  } catch {
    return false;
  }
}

type StreamServerMessage =
  | { type: 'ready'; version: 1 }
  | ({ type: 'snapshot' } & SttSnapshot)
  | ({ type: 'final' } & PublicEvenTurn);

function validStart(message: Partial<StartMessage>): message is StartMessage {
  return (
    message.type === 'start' &&
    message.version === 1 &&
    typeof message.session === 'string' &&
    typeof message.ticket === 'string' &&
    message.format?.encoding === 's16le' &&
    message.format.sampleRate === 16_000 &&
    message.format.channels === 1
  );
}

function validFinish(
  message: Partial<FinishMessage>,
): message is FinishMessage {
  return (
    message.type === 'finish' &&
    Number.isInteger(message.nextSequence) &&
    Number.isInteger(message.durationMs) &&
    typeof message.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(message.sha256)
  );
}

function parseJson(
  data: Buffer | ArrayBuffer | Buffer[],
): Record<string, unknown> {
  try {
    return JSON.parse(toBuffer(data).toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new StreamProtocolError('invalid_json', false);
  }
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function asProtocolError(error: unknown): StreamProtocolError {
  if (error instanceof StreamProtocolError) return error;
  if (error instanceof TurnFinalizationError) {
    return new StreamProtocolError(error.code, error.retryable);
  }
  return new StreamProtocolError('stt_unavailable', true, 1013);
}
