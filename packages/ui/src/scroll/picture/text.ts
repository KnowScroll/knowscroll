/**
 * Measuring and wrapping a picture's labels without a text engine. Layouts run as pure functions on every platform
 * (and in tests), so they estimate a word's width from its characters: an average advance of 0.56 em for the sans
 * labels, a little wider for capitals and narrower for thin letters. The estimate errs wide, so a label fits the room
 * it was given; it never decides anything but where a line breaks.
 */

const NARROW = new Set([..."iljtf.,:;!|'’()[] "]);
const WIDE = new Set([...'mwMW@%']);

/** The estimated width of `text` at `size` pixels. */
export function textWidth(text: string, size: number): number {
  let ems = 0;
  for (const character of text) {
    if (NARROW.has(character)) ems += 0.32;
    else if (WIDE.has(character)) ems += 0.86;
    else if (character >= 'A' && character <= 'Z') ems += 0.66;
    else ems += 0.56;
  }
  return ems * size;
}

/**
 * Words of `text` in lines no wider than `maxWidth` at `size`, at most `maxLines` of them; a last line that would not
 * fit ends with "…". A single word wider than the line is kept whole on its own line: cutting a word inside would
 * change what it says.
 */
export function wrapText(text: string, maxWidth: number, size: number, maxLines = 3): string[] {
  const words = text.split(/\s+/u).filter((word) => word !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && textWidth(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line !== '') lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1] ?? ''}…`;
  return kept;
}

/** The label size for a box: 12 px at the reader's own text size, scaled with it but never above a sixth of the box. */
export function labelSize(boxHeight: number, textScale: number): number {
  return Math.max(9, Math.min(12 * textScale, boxHeight / 6));
}
