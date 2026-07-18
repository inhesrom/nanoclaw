import { describe, expect, it, vi } from 'vitest';

import { EvenHubReadiness } from './readiness.js';

describe('EvenHubReadiness', () => {
  it('maps check failures to down without exposing error details', async () => {
    const readiness = new EvenHubReadiness({
      database: () => true,
      stt: () => {
        throw new Error('private endpoint detail');
      },
      whatsapp: () => false,
      cacheMs: 0,
    });

    await expect(readiness.snapshot()).resolves.toEqual({
      database: 'up',
      stt: 'down',
      whatsapp: 'down',
    });
  });

  it('shares and briefly caches dependency probes', async () => {
    let now = 1_000;
    const stt = vi.fn(async () => true);
    const readiness = new EvenHubReadiness({
      database: () => true,
      stt,
      whatsapp: () => true,
      cacheMs: 1_000,
      now: () => now,
    });

    await Promise.all([readiness.snapshot(), readiness.snapshot()]);
    await readiness.snapshot();
    expect(stt).toHaveBeenCalledOnce();

    now = 2_001;
    await readiness.snapshot();
    expect(stt).toHaveBeenCalledTimes(2);
  });
});
