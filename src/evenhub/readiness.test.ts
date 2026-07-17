import { describe, expect, it, vi } from 'vitest';

import { EvenHubReadiness } from './readiness.js';

describe('EvenHubReadiness', () => {
  it('maps check failures to down without exposing error details', async () => {
    const readiness = new EvenHubReadiness({
      database: () => true,
      whisper: () => {
        throw new Error('private endpoint detail');
      },
      whatsapp: () => false,
      cacheMs: 0,
    });

    await expect(readiness.snapshot()).resolves.toEqual({
      database: 'up',
      whisper: 'down',
      whatsapp: 'down',
    });
  });

  it('shares and briefly caches dependency probes', async () => {
    let now = 1_000;
    const whisper = vi.fn(async () => true);
    const readiness = new EvenHubReadiness({
      database: () => true,
      whisper,
      whatsapp: () => true,
      cacheMs: 1_000,
      now: () => now,
    });

    await Promise.all([readiness.snapshot(), readiness.snapshot()]);
    await readiness.snapshot();
    expect(whisper).toHaveBeenCalledOnce();

    now = 2_001;
    await readiness.snapshot();
    expect(whisper).toHaveBeenCalledTimes(2);
  });
});
