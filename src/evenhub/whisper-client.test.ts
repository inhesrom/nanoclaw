import { describe, expect, it, vi } from 'vitest';

import { createCanonicalWav } from './wav.js';
import { WhisperClient, WhisperClientError } from './whisper-client.js';

describe('WhisperClient', () => {
  it('rejects a non-loopback inference endpoint', () => {
    expect(
      () => new WhisperClient('http://192.168.1.50:8178/inference'),
    ).toThrow('loopback URL');
  });

  it('checks the loopback health endpoint without propagating failures', async () => {
    const healthyFetch = vi.fn(
      async () => new Response('OK', { status: 200 }),
    ) as unknown as typeof fetch;
    const unhealthyFetch = vi.fn(async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    const healthy = new WhisperClient('http://127.0.0.1:8178/inference', {
      fetch: healthyFetch,
    });
    const unhealthy = new WhisperClient('http://127.0.0.1:8178/inference', {
      fetch: unhealthyFetch,
    });

    await expect(healthy.isHealthy()).resolves.toBe(true);
    expect(healthyFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8178/health',
      expect.objectContaining({ method: 'GET' }),
    );
    await expect(unhealthy.isHealthy()).resolves.toBe(false);
  });

  it('posts canonical WAV and stateless inference parameters to loopback', async () => {
    const wav = createCanonicalWav(new Uint8Array(8_000));
    let requestBody: FormData | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: '  tap   to record  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new WhisperClient('http://127.0.0.1:8178/inference', {
      fetch: fetchMock,
    });

    await expect(client.transcribe(wav)).resolves.toBe('tap to record');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestBody?.get('response_format')).toBe('json');
    expect(requestBody?.get('temperature')).toBe('0.0');
    expect(requestBody?.get('prompt')).toBe('');
    expect(requestBody?.get('carry_initial_prompt')).toBe('false');
    expect(requestBody?.get('language')).toBe('en');
    const file = requestBody?.get('file');
    expect(file).toBeInstanceOf(Blob);
    const uploaded = Buffer.from(await (file as Blob).arrayBuffer());
    expect(uploaded).toEqual(wav);
  });

  it('classifies 5xx/transport as retryable and 4xx as invalid audio', async () => {
    const wav = createCanonicalWav(new Uint8Array(8_000));
    const unavailable = new WhisperClient('http://127.0.0.1:8178/inference', {
      fetch: vi.fn(
        async () => new Response('', { status: 503 }),
      ) as unknown as typeof fetch,
    });
    const rejected = new WhisperClient('http://127.0.0.1:8178/inference', {
      fetch: vi.fn(
        async () => new Response('', { status: 400 }),
      ) as unknown as typeof fetch,
    });
    const disconnected = new WhisperClient('http://127.0.0.1:8178/inference', {
      fetch: vi.fn(async () => {
        throw new TypeError('connection refused');
      }) as unknown as typeof fetch,
    });

    await expect(unavailable.transcribe(wav)).rejects.toMatchObject({
      code: 'stt_unavailable',
      retryable: true,
      status: 503,
    } satisfies Partial<WhisperClientError>);
    await expect(rejected.transcribe(wav)).rejects.toMatchObject({
      code: 'invalid_audio',
      retryable: false,
      status: 400,
    } satisfies Partial<WhisperClientError>);
    await expect(disconnected.transcribe(wav)).rejects.toMatchObject({
      code: 'stt_unavailable',
      retryable: true,
    } satisfies Partial<WhisperClientError>);
  });
});
