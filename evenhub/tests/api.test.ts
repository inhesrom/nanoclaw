import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvenHubApi, TAILSCALE_UNAVAILABLE_MESSAGE } from '../src/api';

const origin = 'https://nanoclaw.example.ts.net';

afterEach(() => vi.unstubAllGlobals());

describe('EvenHub Tailscale API', () => {
  it('probes readiness only through the pinned tailnet origin', async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ status: 'ready' }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new EvenHubApi(origin).checkReady();

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${origin}/api/even/v1/readyz`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: { 'X-EvenHub-Protocol-Version': '2' },
      signal: expect.any(AbortSignal),
    });
  });

  it('posts explicit confirmation decisions with protocol and bearer headers', async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ turnId: 'turn-1', state: 'discarded' }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new EvenHubApi(origin).confirmTurn('token', 'turn-1', 'discard');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${origin}/api/even/v1/turns/turn-1/confirmation`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'X-EvenHub-Protocol-Version': '2',
      },
      body: JSON.stringify({ decision: 'discard' }),
    });
  });

  it('normalizes network failures to actionable Tailscale guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await expect(new EvenHubApi(origin).checkReady()).rejects.toMatchObject({
      status: 0,
      code: 'tailscale_unavailable',
      message: TAILSCALE_UNAVAILABLE_MESSAGE,
      retryable: true,
    });
  });
});
