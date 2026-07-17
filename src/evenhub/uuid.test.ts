import { describe, expect, it } from 'vitest';

import { createUuidV7, isUuidV4 } from './uuid.js';

describe('EvenHub UUID helpers', () => {
  it('creates UUIDv7 identifiers containing the supplied timestamp', () => {
    const id = createUuidV7(1_700_000_000_000);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(
      1_700_000_000_000,
    );
  });

  it('only accepts UUIDv4 idempotency keys', () => {
    expect(isUuidV4('b1c305c5-cdee-4c67-aed7-87b85e500f25')).toBe(true);
    expect(isUuidV4(createUuidV7())).toBe(false);
  });
});
