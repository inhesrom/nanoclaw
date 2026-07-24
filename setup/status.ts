/**
 * Structured status block output for setup steps.
 * Each step emits a block that the SKILL.md LLM can parse.
 */

export function emitStatus(
  step: string,
  fields: Record<string, string | number | boolean>,
): void {
  const lines = [`=== NANOCLAW SETUP: ${step} ===`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}

/**
 * Parse the last status block from a step's captured output.
 * Returns the fields plus STEP (the block's step name), or null when no
 * complete block is present.
 */
export function parseStatusBlock(
  output: string,
): Record<string, string> | null {
  const blocks = [
    ...output.matchAll(
      /^=== NANOCLAW SETUP: (.+?) ===\n([\s\S]*?)^=== END ===/gm,
    ),
  ];
  const last = blocks[blocks.length - 1];
  if (!last) return null;

  const fields: Record<string, string> = { STEP: last[1] };
  for (const line of last[2].split('\n')) {
    const sep = line.indexOf(': ');
    if (sep > 0) fields[line.slice(0, sep)] = line.slice(sep + 2);
  }
  return fields;
}
