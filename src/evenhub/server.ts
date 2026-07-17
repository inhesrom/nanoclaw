import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { Readable } from 'stream';

import {
  activateEvenDeviceFromPairingCode,
  clearEvenPairingFailures,
  getActiveEvenDevices,
  getEvenPairingAttempt,
  getEvenPairingCode,
  getEvenTurnByIdempotencyKey,
  getEvenTurnForDevice,
  insertEvenTurn,
  recordEvenPairingFailure,
  touchEvenDevice,
  transitionEvenTurnState,
} from '../db.js';
import { logger } from '../logger.js';
import type { EvenDevice, EvenTurn } from './types.js';
import { toPublicEvenTurn } from './types.js';
import { createUuidV7, isUuidV4 } from './uuid.js';
import { sha256 } from './pairing.js';

const AUDIO_CONTENT_TYPE = 'audio/L16;rate=16000;channels=1';
const MAX_JSON_BYTES = 16 * 1024;
const PAIR_FAILURE_LIMIT = 5;
const PAIR_LOCK_MS = 15 * 60 * 1000;

export interface EvenTurnProcessor {
  process(turn: EvenTurn): Promise<void>;
}

export interface EvenHubServerOptions {
  host: string;
  port: number;
  audioDir: string;
  maxAudioBytes?: number;
  pairingTtlMs?: number;
  processor?: EvenTurnProcessor;
}

export interface InjectedEvenHubRequest {
  method: string;
  pathname: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  remoteAddress?: string;
}

export interface InjectedEvenHubResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface WrittenAudio {
  sha256: string;
  size: number;
  tempPath: string;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Idempotency-Key, X-Audio-Duration-Ms',
    'Access-Control-Max-Age': '600',
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: ApiError): void {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BYTES) {
      throw new ApiError(413, 'request_too_large', 'Request body is too large');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

async function writeAudio(
  request: IncomingMessage,
  audioDir: string,
  maxBytes: number,
): Promise<WrittenAudio> {
  fs.mkdirSync(audioDir, { recursive: true });
  const tempPath = path.join(audioDir, `.${createUuidV7()}.part`);
  const file = fs.openSync(tempPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  let complete = false;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        throw new ApiError(
          413,
          'audio_too_large',
          `Audio must not exceed ${maxBytes} bytes`,
        );
      }
      hash.update(bytes);
      fs.writeSync(file, bytes);
    }
    fs.fsyncSync(file);
    complete = true;
    return { sha256: hash.digest('hex'), size, tempPath };
  } finally {
    fs.closeSync(file);
    if (!complete) fs.rmSync(tempPath, { force: true });
  }
}

function remoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress || 'unknown';
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{32,})$/);
  if (!match) {
    throw new ApiError(
      401,
      'invalid_token',
      'A device bearer token is required',
    );
  }
  return match[1];
}

function authorize(request: IncomingMessage): EvenDevice {
  const candidate = sha256(bearerToken(request));
  const device = getActiveEvenDevices().find((current) =>
    safeHashEquals(current.token_sha256, candidate),
  );
  if (!device) {
    throw new ApiError(
      401,
      'invalid_token',
      'Device token is invalid or revoked',
    );
  }
  touchEvenDevice(device.id, new Date().toISOString());
  return device;
}

function validateTurnHeaders(request: IncomingMessage): {
  idempotencyKey: string;
  durationMs: number;
} {
  if (request.headers['content-type'] !== AUDIO_CONTENT_TYPE) {
    throw new ApiError(
      415,
      'unsupported_audio_format',
      `Content-Type must be ${AUDIO_CONTENT_TYPE}`,
    );
  }
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !isUuidV4(idempotencyKey)) {
    throw new ApiError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be a UUIDv4',
    );
  }
  const rawDuration = request.headers['x-audio-duration-ms'];
  const durationMs =
    typeof rawDuration === 'string' && /^\d+$/.test(rawDuration)
      ? Number(rawDuration)
      : Number.NaN;
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 250 ||
    durationMs > 30_000
  ) {
    throw new ApiError(
      400,
      'invalid_audio_duration',
      'X-Audio-Duration-Ms must be an integer from 250 to 30000',
    );
  }
  return { idempotencyKey, durationMs };
}

export class EvenHubServer {
  private readonly maxAudioBytes: number;
  private server?: http.Server;

  constructor(private readonly options: EvenHubServerOptions) {
    this.maxAudioBytes = options.maxAudioBytes ?? 960_000;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const current = this.server;
    this.server = undefined;
    if (!current) return;
    if (!current.listening) return;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
    });
  }

  address(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new Error('EvenHub server is not listening');
    }
    return { host: this.options.host, port: address.port };
  }

  /** @internal Exercises the production request handler without binding a port. */
  async inject(
    input: InjectedEvenHubRequest,
  ): Promise<InjectedEvenHubResponse> {
    const payload =
      typeof input.body === 'string'
        ? Buffer.from(input.body)
        : Buffer.from(input.body ?? new Uint8Array());
    const request = Readable.from(payload.length > 0 ? [payload] : []) as
      | IncomingMessage
      | Readable;
    Object.assign(request, {
      method: input.method,
      url: input.pathname,
      headers: Object.fromEntries(
        Object.entries(input.headers ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
      socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
    });

    let status = 0;
    let responseHeaders: Record<string, string> = {};
    let responseBody = '';
    const response = {
      writeHead(
        nextStatus: number,
        headers: Record<string, string | number | readonly string[]>,
      ) {
        status = nextStatus;
        responseHeaders = Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, String(value)]),
        );
        return response;
      },
      end(chunk?: string | Buffer) {
        responseBody = chunk?.toString() ?? '';
        return response;
      },
    } as unknown as ServerResponse;

    await this.handle(request as IncomingMessage, response);
    return {
      status,
      headers: responseHeaders,
      body: responseBody ? (JSON.parse(responseBody) as unknown) : undefined,
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }

      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/api/even/v1/healthz') {
        sendJson(response, 200, {
          status: 'ok',
          processor: this.options.processor ? 'ready' : 'not_configured',
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/even/v1/pair') {
        await this.handlePair(request, response);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/even/v1/turns') {
        await this.handleCreateTurn(request, response);
        return;
      }
      const turnMatch = pathname.match(/^\/api\/even\/v1\/turns\/([^/]+)$/);
      if (request.method === 'GET' && turnMatch) {
        this.handleGetTurn(request, response, turnMatch[1]);
        return;
      }
      throw new ApiError(404, 'not_found', 'Route not found');
    } catch (error) {
      if (error instanceof ApiError) {
        sendError(response, error);
        return;
      }
      logger.error({ err: error }, 'EvenHub request failed');
      sendError(
        response,
        new ApiError(
          500,
          'internal_error',
          'The request could not be completed',
        ),
      );
    }
  }

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const address = remoteAddress(request);
    const now = new Date();
    const attempt = getEvenPairingAttempt(address);
    if (
      attempt?.locked_until &&
      Date.parse(attempt.locked_until) > now.getTime()
    ) {
      throw new ApiError(
        429,
        'pairing_locked',
        'Too many failed pairing attempts; try again later',
      );
    }

    const body = await readJson(request);
    if (!body || typeof body !== 'object') {
      throw new ApiError(
        400,
        'invalid_pairing_request',
        'Pairing body is required',
      );
    }
    const { code, deviceName } = body as Record<string, unknown>;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new ApiError(
        400,
        'invalid_pairing_code',
        'Code must contain six digits',
      );
    }
    if (
      typeof deviceName !== 'string' ||
      deviceName.trim().length < 1 ||
      deviceName.trim().length > 64
    ) {
      throw new ApiError(
        400,
        'invalid_device_name',
        'Device name must contain 1 to 64 characters',
      );
    }

    const pairing = getEvenPairingCode();
    const candidateHash = sha256(code);
    const valid =
      pairing &&
      !pairing.consumed_at &&
      Date.parse(pairing.expires_at) > now.getTime() &&
      safeHashEquals(pairing.code_sha256, candidateHash);
    if (!valid) {
      const failure = recordEvenPairingFailure(
        address,
        now,
        PAIR_FAILURE_LIMIT,
        PAIR_LOCK_MS,
      );
      if (failure.locked_until) {
        throw new ApiError(
          429,
          'pairing_locked',
          'Too many failed pairing attempts; try again later',
        );
      }
      throw new ApiError(
        401,
        'invalid_pairing_code',
        'Pairing code is invalid or expired',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const deviceId = createUuidV7();
    const timestamp = now.toISOString();
    const activated = activateEvenDeviceFromPairingCode(
      candidateHash,
      {
        id: deviceId,
        name: deviceName.trim(),
        token_sha256: sha256(token),
        created_at: timestamp,
        last_used_at: timestamp,
        revoked_at: null,
      },
      timestamp,
    );
    if (!activated) {
      throw new ApiError(
        409,
        'pairing_already_used',
        'Pairing code has already been used',
      );
    }
    clearEvenPairingFailures(address);
    sendJson(response, 201, { deviceId, token });
  }

  private async handleCreateTurn(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const device = authorize(request);
    const { idempotencyKey, durationMs } = validateTurnHeaders(request);
    const contentLength = Number(request.headers['content-length'] || 0);
    if (contentLength > this.maxAudioBytes) {
      throw new ApiError(
        413,
        'audio_too_large',
        `Audio must not exceed ${this.maxAudioBytes} bytes`,
      );
    }

    const written = await writeAudio(
      request,
      this.options.audioDir,
      this.maxAudioBytes,
    );
    if (written.size % 2 !== 0) {
      fs.rmSync(written.tempPath, { force: true });
      throw new ApiError(
        422,
        'invalid_audio',
        'PCM audio must contain complete signed 16-bit samples',
      );
    }
    const expectedBytes = durationMs * 32;
    if (written.size === 0 || Math.abs(written.size - expectedBytes) > 640) {
      fs.rmSync(written.tempPath, { force: true });
      throw new ApiError(
        422,
        'audio_duration_mismatch',
        'PCM byte count does not match the declared duration',
      );
    }

    const existing = getEvenTurnByIdempotencyKey(device.id, idempotencyKey);
    if (existing) {
      fs.rmSync(written.tempPath, { force: true });
      if (existing.request_sha256 !== written.sha256) {
        throw new ApiError(
          409,
          'idempotency_payload_mismatch',
          'Idempotency-Key was already used with different audio',
        );
      }
      sendJson(response, 200, toPublicEvenTurn(existing), {
        'Idempotency-Replayed': 'true',
      });
      return;
    }

    const id = createUuidV7();
    const finalPath = path.join(this.options.audioDir, `${id}.pcm`);
    const timestamp = new Date().toISOString();
    fs.renameSync(written.tempPath, finalPath);
    const turn: EvenTurn = {
      id,
      device_id: device.id,
      idempotency_key: idempotencyKey,
      request_sha256: written.sha256,
      audio_path: finalPath,
      audio_duration_ms: durationMs,
      state: 'accepted',
      transcript: null,
      whatsapp_message_id: null,
      answer: null,
      error_code: null,
      error_message: null,
      stt_attempts: 0,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    };
    try {
      insertEvenTurn(turn);
    } catch (error) {
      fs.rmSync(finalPath, { force: true });
      const raced = getEvenTurnByIdempotencyKey(device.id, idempotencyKey);
      if (!raced) throw error;
      if (raced.request_sha256 !== written.sha256) {
        throw new ApiError(
          409,
          'idempotency_payload_mismatch',
          'Idempotency-Key was already used with different audio',
        );
      }
      sendJson(response, 200, toPublicEvenTurn(raced), {
        'Idempotency-Replayed': 'true',
      });
      return;
    }

    sendJson(response, 202, toPublicEvenTurn(turn));
    logger.info(
      {
        turn_id: id,
        state: 'accepted',
        audio_duration_ms: durationMs,
        audio_bytes: written.size,
      },
      'even.turn.accepted',
    );
    if (this.options.processor) {
      setImmediate(() => {
        void this.options.processor!.process(turn).catch((error) => {
          logger.error(
            { err: error, turnId: id },
            'EvenHub turn processor failed',
          );
          const failedAt = new Date().toISOString();
          transitionEvenTurnState(id, 'accepted', 'failed', {
            errorCode: 'processor_failed',
            errorMessage: 'Turn processing failed',
            completedAt: failedAt,
          });
        });
      });
    }
  }

  private handleGetTurn(
    request: IncomingMessage,
    response: ServerResponse,
    turnId: string,
  ): void {
    const device = authorize(request);
    const turn = getEvenTurnForDevice(turnId, device.id);
    if (!turn) throw new ApiError(404, 'turn_not_found', 'Turn not found');
    sendJson(response, 200, toPublicEvenTurn(turn));
  }
}
