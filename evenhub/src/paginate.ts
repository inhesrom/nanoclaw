import { measureTextWrap } from '@evenrealities/pretext';

const LINE_HEIGHT = 27;

export interface PaginateBox {
  width: number;
  height: number;
}

// Follows the official text-heavy template's pre-measure/pack approach.
export function paginate(source: string, box: PaginateBox): string[] {
  const maxLines = Math.max(1, Math.floor(box.height / LINE_HEIGHT));
  const paragraphs = source
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const pages: string[] = [];
  let buffer: string[] = [];
  let lineCount = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    pages.push(buffer.join('\n\n'));
    buffer = [];
    lineCount = 0;
  };

  for (const paragraph of paragraphs) {
    const paragraphLines = measureTextWrap(paragraph, box.width).lineCount;
    if (paragraphLines > maxLines) {
      flush();
      pages.push(...splitParagraph(paragraph, box.width, maxLines));
      continue;
    }
    const cost = paragraphLines + (buffer.length > 0 ? 1 : 0);
    if (lineCount + cost > maxLines) flush();
    buffer.push(paragraph);
    lineCount += paragraphLines + (buffer.length > 1 ? 1 : 0);
  }
  flush();
  return pages;
}

function splitParagraph(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const token of text.split(/(\s+)/)) {
    const candidate = current + token;
    if (
      measureTextWrap(candidate, width).lineCount > maxLines &&
      current.trim()
    ) {
      chunks.push(current.trim());
      current = token.replace(/^\s+/, '');
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
