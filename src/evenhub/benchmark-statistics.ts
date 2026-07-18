export interface WerCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
  errors: number;
  referenceWords: number;
  wer: number;
}

export function normalizeWerText(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .trim()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function wordErrorRate(
  reference: string,
  hypothesis: string,
): WerCounts {
  const referenceWords = words(reference);
  const hypothesisWords = words(hypothesis);
  const rows: Array<Array<{ cost: number; s: number; d: number; i: number }>> =
    [];
  for (let row = 0; row <= referenceWords.length; row += 1) {
    rows[row] = [];
    for (let column = 0; column <= hypothesisWords.length; column += 1) {
      if (row === 0) {
        rows[row][column] = { cost: column, s: 0, d: 0, i: column };
      } else if (column === 0) {
        rows[row][column] = { cost: row, s: 0, d: row, i: 0 };
      } else if (referenceWords[row - 1] === hypothesisWords[column - 1]) {
        rows[row][column] = rows[row - 1][column - 1];
      } else {
        const substitution = rows[row - 1][column - 1];
        const deletion = rows[row - 1][column];
        const insertion = rows[row][column - 1];
        const options = [
          {
            cost: substitution.cost + 1,
            s: substitution.s + 1,
            d: substitution.d,
            i: substitution.i,
          },
          {
            cost: deletion.cost + 1,
            s: deletion.s,
            d: deletion.d + 1,
            i: deletion.i,
          },
          {
            cost: insertion.cost + 1,
            s: insertion.s,
            d: insertion.d,
            i: insertion.i + 1,
          },
        ];
        rows[row][column] = options.reduce((best, candidate) =>
          candidate.cost < best.cost ? candidate : best,
        );
      }
    }
  }
  const final = rows[referenceWords.length][hypothesisWords.length];
  return {
    substitutions: final.s,
    deletions: final.d,
    insertions: final.i,
    errors: final.cost,
    referenceWords: referenceWords.length,
    wer:
      referenceWords.length === 0
        ? final.cost === 0
          ? 0
          : 1
        : final.cost / referenceWords.length,
  };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0)
    throw new Error('percentile requires at least one value');
  if (fraction < 0 || fraction > 1)
    throw new Error('percentile fraction must be between 0 and 1');
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

export function seededOrder<T>(values: T[], seed: number): T[] {
  const result = [...values];
  const random = mulberry32(seed >>> 0);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function runSeed(baseSeed: number, run: number): number {
  return (baseSeed + Math.imul(run, 0x9e3779b9)) >>> 0;
}

function words(value: string): string[] {
  const normalized = normalizeWerText(value);
  return normalized ? normalized.split(' ') : [];
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
