/**
 * Measuring and wrapping a picture's labels without a text engine. Layouts run as pure functions on every platform
 * (and in tests), so they estimate a word's width from its characters: an average advance of 0.56 em for the sans
 * labels, a little wider for capitals and narrower for thin letters; a monospaced face has one advance for every
 * character. The estimate errs wide, so a label fits the room it was given; it never decides anything but where a line
 * breaks.
 */

/** The face a text is set in; only the monospaced one changes how its width is estimated. */
export type TextFamily = 'sans' | 'mono' | 'serif';

/** A monospaced glyph's advance in em, with a little over the font's 0.6 so a line fits whichever mono face is used. */
export const MONO_ADVANCE = 0.62;

const NARROW = new Set([..."iljtf.,:;!|'’()[] "]);
const WIDE = new Set([...'mwMW@%']);

/** The estimated width of `text` at `size` pixels, in `family` (sans unless given). */
export function textWidth(text: string, size: number, family: TextFamily = 'sans'): number {
  if (family === 'mono') return [...text].length * MONO_ADVANCE * size;
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
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  maxLines = 3,
  family: TextFamily = 'sans',
): string[] {
  const words = text.split(/\s+/u).filter((word) => word !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && textWidth(candidate, size, family) > maxWidth) {
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
