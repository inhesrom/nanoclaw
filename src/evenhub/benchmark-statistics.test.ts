import { describe, expect, it } from 'vitest';

import {
  normalizeWerText,
  percentile,
  runSeed,
  seededOrder,
  wordErrorRate,
} from './benchmark-statistics.js';

describe('EvenHub benchmark statistics', () => {
  it('normalizes only case, Unicode punctuation, edges, and whitespace', () => {
    expect(normalizeWerText('  Meet José—at 4:30…  ')).toBe(
      'meet josé at 4 30',
    );
    expect(normalizeWerText('twenty-one')).toBe('twenty one');
    expect(normalizeWerText('4')).not.toBe(normalizeWerText('four'));
  });

  it('reports substitution, deletion, insertion, and aggregate WER counts', () => {
    expect(
      wordErrorRate('call Alice tomorrow', 'call Alex soon please'),
    ).toEqual({
      substitutions: 2,
      deletions: 0,
      insertions: 1,
      errors: 3,
      referenceWords: 3,
      wer: 1,
    });
    expect(wordErrorRate('Hello, world!', 'hello world').wer).toBe(0);
  });

  it('uses nearest-rank percentiles', () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile(values, 1)).toBe(20);
  });

  it('produces deterministic seeded Fisher-Yates orders per run', () => {
    const values = Array.from({ length: 30 }, (_, index) => index);
    const first = seededOrder(values, runSeed(1234, 0));
    expect(first).toEqual(seededOrder(values, runSeed(1234, 0)));
    expect(first).not.toEqual(seededOrder(values, runSeed(1234, 1)));
    expect([...first].sort((left, right) => left - right)).toEqual(values);
  });
});
