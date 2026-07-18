import { measureTextWrap } from '@evenrealities/pretext';

export const G2_FEED_WIDTH = 544;
export const G2_FEED_LINES = 8;
export const G2_SCROLL_LINES = 4;
export const G2_SCROLLBAR_ROWS = 8;
export const G2_SCROLLBAR_TRACK_GLYPH = ' ';
export const G2_SCROLLBAR_THUMB_GLYPH = '|';

export type ConversationSpeaker = 'You' | 'NanoClaw' | 'Notice';

export interface ConversationEntry {
  id: string;
  speaker: ConversationSpeaker;
  text: string;
}

export interface ConversationProjection {
  body: string;
  lines: string[];
  offset: number;
  maxOffset: number;
  hasEarlier: boolean;
  hasLater: boolean;
  ranges: Record<string, { start: number; end: number }>;
}

interface LayoutOptions {
  width?: number;
  viewportLines?: number;
  offset?: number;
}

/** Wraps the whole ledger before selecting a viewport-sized continuous slice. */
export function projectConversationFeed(
  entries: readonly ConversationEntry[],
  options: LayoutOptions = {},
): ConversationProjection {
  const width = options.width ?? G2_FEED_WIDTH;
  const viewportLines = options.viewportLines ?? G2_FEED_LINES;
  const lines: string[] = [];
  const ranges: Record<string, { start: number; end: number }> = {};

  for (const entry of entries) {
    if (lines.length > 0) lines.push('');
    const start = lines.length;
    lines.push(...wrapText(`${entry.speaker}: ${entry.text.trim()}`, width));
    ranges[entry.id] = { start, end: lines.length };
  }

  const maxOffset = Math.max(0, lines.length - viewportLines);
  const offset = clamp(options.offset ?? maxOffset, 0, maxOffset);
  return {
    body: lines.slice(offset, offset + viewportLines).join('\n'),
    lines,
    offset,
    maxOffset,
    hasEarlier: offset > 0,
    hasLater: offset < maxOffset,
    ranges,
  };
}

/**
 * Short replies retain preceding context; replies taller than the viewport start
 * at their first line so their opening is never skipped.
 */
export function anchorConversationEntry(
  projection: ConversationProjection,
  entryId: string,
  viewportLines = G2_FEED_LINES,
): number {
  const range = projection.ranges[entryId];
  if (!range) return projection.maxOffset;
  const entryLines = range.end - range.start;
  return clamp(
    entryLines >= viewportLines ? range.start : range.end - viewportLines,
    0,
    projection.maxOffset,
  );
}

export function scrollConversation(
  projection: ConversationProjection,
  direction: -1 | 1,
): number {
  return clamp(
    projection.offset + direction * G2_SCROLL_LINES,
    0,
    projection.maxOffset,
  );
}

/** Projects the wrapped feed viewport onto an eight-glyph proportional track. */
export function projectConversationScrollbar(
  projection: Pick<ConversationProjection, 'lines' | 'offset' | 'maxOffset'>,
  viewportLines = G2_FEED_LINES,
  trackRows = G2_SCROLLBAR_ROWS,
): string {
  const totalLines = projection.lines.length;
  if (totalLines <= viewportLines || trackRows < 1) return '';
  const visibleLines = Math.min(viewportLines, totalLines);
  const thumbRows = Math.max(
    1,
    Math.min(trackRows, Math.round((visibleLines / totalLines) * trackRows)),
  );
  const travel = trackRows - thumbRows;
  const thumbStart =
    projection.maxOffset === 0
      ? 0
      : Math.round((projection.offset / projection.maxOffset) * travel);
  return new Array(trackRows)
    .fill(G2_SCROLLBAR_TRACK_GLYPH)
    .map((glyph, row) =>
      row >= thumbStart && row < thumbStart + thumbRows
        ? G2_SCROLLBAR_THUMB_GLYPH
        : glyph,
    )
    .join('\n');
}

function wrapText(source: string, width: number): string[] {
  const output: string[] = [];
  for (const paragraph of source.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      output.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureTextWrap(candidate, width).lineCount <= 1) {
        current = candidate;
        continue;
      }
      if (current) output.push(current);
      const pieces = splitLongWord(word, width);
      output.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? '';
    }
    if (current) output.push(current);
  }
  return output.length > 0 ? output : [''];
}

function splitLongWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const character of word) {
    const candidate = current + character;
    if (current && measureTextWrap(candidate, width).lineCount > 1) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
