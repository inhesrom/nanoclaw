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
  getEvenTurnForDevice,
  recordEvenPairingFailure,
  resolveEvenTurnConfirmation,
  touchEvenDevice,
  transitionEvenTurnState,
} from '../db.js';
import { logger } from '../logger.js';
import type { EvenDevice, EvenTurn } from './types.js';
import { toPublicEvenTurn } from './types.js';
import { createUuidV7, isUuidV4 } from './uuid.js';
import { sha256 } from './pairing.js';
import type {
  EvenHubDependencySnapshot,
  EvenHubReadinessProbe,
} from './readiness.js';
import type { SttStreamingProvider } from './stt-client.js';
import { EvenHubStreamingGateway, StreamProtocolError } from './streaming.js';
import { EvenTurnFinalizer, TurnFinalizationError } from './turn-finalizer.js';

const AUDIO_CONTENT_TYPE = 'audio/L16;rate=16000;channels=1';
const MAX_JSON_BYTES = 16 * 1024;
const PAIR_FAILURE_LIMIT = 5;
const PAIR_LOCK_MS = 15 * 60 * 1000;
export const EVENHUB_PROTOCOL_VERSION = 2;
export const EVENHUB_RELEASE_VERSION = '0.4.0';

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
  readiness?: EvenHubReadinessProbe;
  publicOrigin?: string;
  streamingStt?: SttStreamingProvider;
  finalizer?: EvenTurnFinalizer;
  onDispatchReady?: () => void;
  version?: string;
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
      'Authorization, Content-Type, Idempotency-Key, X-Audio-Duration-Ms, X-EvenHub-Protocol-Version',
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

function requireProtocolVersion(request: IncomingMessage): void {
  if (
    request.headers['x-evenhub-protocol-version'] !==
    String(EVENHUB_PROTOCOL_VERSION)
  ) {
    throw new ApiError(
      426,
      'client_upgrade_required',
      `X-EvenHub-Protocol-Version must be ${EVENHUB_PROTOCOL_VERSION}`,
    );
  }
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
  private readonly finalizer: EvenTurnFinalizer;
  private readonly streaming?: EvenHubStreamingGateway;
  private readonly processorTasks = new Set<Promise<void>>();
  private server?: http.Server;

  constructor(private readonly options: EvenHubServerOptions) {
    this.maxAudioBytes = options.maxAudioBytes ?? 960_000;
    this.finalizer =
      options.finalizer ??
      new EvenTurnFinalizer({
        audioDir: options.audioDir,
        maxAudioBytes: this.maxAudioBytes,
      });
    if (options.streamingStt) {
      if (!options.publicOrigin) {
        throw new Error('publicOrigin is required when streaming is enabled');
      }
      this.streaming = new EvenHubStreamingGateway({
        audioDir: options.audioDir,
        publicOrigin: options.publicOrigin,
        stt: options.streamingStt,
        finalizer: this.finalizer,
      });
    }
  }

  private async dependencies(): Promise<EvenHubDependencySnapshot> {
    return (
      (await this.options.readiness?.snapshot()) ?? {
        database: 'up',
        stt: 'up',
        whatsapp: 'up',
      }
    );
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      if (this.streaming) {
        this.streaming.handleUpgrade(request, socket, head);
        return;
      }
      socket.destroy();
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
    await this.streaming?.stop();
    if (current?.listening) {
      await new Promise<void>((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await Promise.allSettled([...this.processorTasks]);
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
        const dependencies = await this.dependencies();
        sendJson(response, 200, {
          status: Object.values(dependencies).every((state) => state === 'up')
            ? 'ok'
            : 'degraded',
          version: this.options.version ?? EVENHUB_RELEASE_VERSION,
          stt: dependencies.stt,
          whatsapp: dependencies.whatsapp,
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/even/v1/readyz') {
        requireProtocolVersion(request);
        const dependencies = await this.dependencies();
        const unavailable = Object.entries(dependencies)
          .filter(([, state]) => state === 'down')
          .map(([component]) => component);
        sendJson(response, unavailable.length === 0 ? 200 : 503, {
          status: unavailable.length === 0 ? 'ready' : 'not_ready',
          components:
            unavailable.length === 0
              ? ['api', 'database', 'stt', 'whatsapp']
              : unavailable,
          protocolVersion: EVENHUB_PROTOCOL_VERSION,
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
      if (
        request.method === 'POST' &&
        pathname === '/api/even/v1/stt-sessions'
      ) {
        await this.handleCreateSttSession(request, response);
        return;
      }
      const turnMatch = pathname.match(/^\/api\/even\/v1\/turns\/([^/]+)$/);
      if (request.method === 'GET' && turnMatch) {
        this.handleGetTurn(request, response, turnMatch[1]);
        return;
      }
      const confirmationMatch = pathname.match(
        /^\/api\/even\/v1\/turns\/([^/]+)\/confirmation$/,
      );
      if (request.method === 'POST' && confirmationMatch) {
        await this.handleConfirmation(request, response, confirmationMatch[1]);
        return;
      }
      throw new ApiError(404, 'not_found', 'Route not found');
    } catch (error) {
      if (error instanceof ApiError) {
        sendError(response, error);
        return;
      }
      if (error instanceof TurnFinalizationError) {
        sendError(
          response,
          new ApiError(
            error.status,
            error.code,
            error.message,
            error.retryable,
          ),
        );
        return;
      }
      logger.error(
        { error_type: error instanceof Error ? error.name : 'UnknownError' },
        'even.request_failed',
      );
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
      logger.warn(
        {
          address_hash: sha256(address).slice(0, 12),
          failure_count: attempt.failures,
        },
        'even.auth_lockout',
      );
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
        logger.warn(
          {
            address_hash: sha256(address).slice(0, 12),
            failure_count: failure.failures,
          },
          'even.auth_lockout',
        );
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
    requireProtocolVersion(request);
    const dependencies = await this.dependencies();
    const unavailable = Object.entries(dependencies)
      .filter(([, state]) => state === 'down')
      .map(([component]) => component);
    if (unavailable.length > 0) {
      throw new ApiError(
        503,
        'not_ready',
        `EvenHub is waiting for ${unavailable.join(', ')}`,
        true,
      );
    }

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
    const accepted = this.finalizer.accept(device, idempotencyKey, {
      ...written,
      durationMs,
    });
    sendJson(
      response,
      accepted.created ? 202 : 200,
      toPublicEvenTurn(accepted.turn),
      accepted.created ? {} : { 'Idempotency-Replayed': 'true' },
    );
    if (accepted.created && this.options.processor) {
      const task = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.options.processor!.process(accepted.turn))
        .catch((error) => {
          logger.error(
            {
              turn_id: accepted.turn.id,
              state: 'accepted',
              error_type: error instanceof Error ? error.name : 'UnknownError',
            },
            'even.turn_processor_failed',
          );
          try {
            const failedAt = new Date().toISOString();
            transitionEvenTurnState(accepted.turn.id, 'accepted', 'failed', {
              errorCode: 'processor_failed',
              errorMessage: 'Turn processing failed',
              completedAt: failedAt,
            });
          } catch (recoveryError) {
            logger.error(
              {
                turn_id: accepted.turn.id,
                state: 'accepted',
                error_type:
                  recoveryError instanceof Error
                    ? recoveryError.name
                    : 'UnknownError',
              },
              'even.turn_processor_recovery_failed',
            );
          }
        });
      this.processorTasks.add(task);
      void task.finally(() => this.processorTasks.delete(task));
    }
  }

  private async handleCreateSttSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    requireProtocolVersion(request);
    if (!this.streaming) {
      throw new ApiError(
        503,
        'stt_unavailable',
        'Local speech recognition is unavailable',
        true,
      );
    }
    const dependencies = await this.dependencies();
    if (dependencies.database === 'down' || dependencies.stt === 'down') {
      throw new ApiError(
        503,
        'not_ready',
        'EvenHub is waiting for local speech recognition',
        true,
      );
    }
    const device = authorize(request);
    const body = await readJson(request);
    const idempotencyKey =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).idempotencyKey
        : undefined;
    if (typeof idempotencyKey !== 'string') {
      throw new ApiError(
        400,
        'invalid_idempotency_key',
        'idempotencyKey must be a UUIDv4',
      );
    }
    try {
      sendJson(
        response,
        201,
        this.streaming.createSession(device, idempotencyKey),
      );
    } catch (error) {
      if (error instanceof StreamProtocolError) {
        throw new ApiError(400, error.code, error.message, error.retryable);
      }
      throw error;
    }
  }

  private handleGetTurn(
    request: IncomingMessage,
    response: ServerResponse,
    turnId: string,
  ): void {
    requireProtocolVersion(request);
    const device = authorize(request);
    const turn = getEvenTurnForDevice(turnId, device.id);
    if (!turn) throw new ApiError(404, 'turn_not_found', 'Turn not found');
    sendJson(response, 200, toPublicEvenTurn(turn));
  }

  private async handleConfirmation(
    request: IncomingMessage,
    response: ServerResponse,
    turnId: string,
  ): Promise<void> {
    requireProtocolVersion(request);
    const device = authorize(request);
    const turn = getEvenTurnForDevice(turnId, device.id);
    if (!turn) throw new ApiError(404, 'turn_not_found', 'Turn not found');

    const body = await readJson(request);
    const decision =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).decision
        : undefined;
    if (decision !== 'send' && decision !== 'discard') {
      throw new ApiError(
        400,
        'invalid_confirmation_decision',
        'decision must be send or discard',
      );
    }

    const result = resolveEvenTurnConfirmation(turn.id, decision);
    if (!result || result.status === 'conflict') {
      throw new ApiError(
        409,
        'turn_already_resolved',
        'Turn has already been resolved',
      );
    }
    if (result.status === 'resolved') {
      logger.info(
        { turn_id: turn.id, state: result.turn.state },
        'even.turn.confirmed',
      );
    }
    if (decision === 'send') {
      try {
        this.options.onDispatchReady?.();
      } catch (error) {
        logger.error(
          {
            turn_id: turn.id,
            state: result.turn.state,
            error_type: error instanceof Error ? error.name : 'UnknownError',
          },
          'even.dispatch_wake_failed',
        );
      }
    }
    sendJson(
      response,
      200,
      toPublicEvenTurn(result.turn),
      result.status === 'idempotent' ? { 'Confirmation-Replayed': 'true' } : {},
    );
  }
}
