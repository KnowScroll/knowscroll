import { MAGNITUDES, type Magnitude } from '../../v2/blocks.js';

/**
 * How a passage writes one figure of a scale or a chart (D-208). A value is the figure as a passage writes
 * it, so the passage is read the way a person reads it: thousands separators are dropped from both
 * sides, a word may follow after a space or a hyphen ("8.3 million", "8.3-million"), and anything that
 * scales a figure without being one of the four magnitude words ("8.3m", "8.3bn", "8.3 crore") or that
 * makes the figure one end of a range ("8 to 10 million") is a way of writing it that a value cannot
 * state, so a point resting on it is refused.
 */
export type Reading = 'bare' | 'unknown' | Magnitude;

/** Words and letters that scale a figure but are not a magnitude the document can hold. */
const UNKNOWN_SCALERS = new Set([
  'k',
  'm',
  'mn',
  'mm',
  'b',
  'bn',
  'tn',
  't',
  'cr',
  'crore',
  'crores',
  'lakh',
  'lakhs',
  'lac',
  'lacs',
]);

/** A number as a passage writes it: digits with thousands separators and a decimal part, never ending in a comma or a point. */
const NUMBER = /(?<![\p{L}\p{N}.,])\d+(?:,\d{3})*(?:\.\d+)?(?![\p{N}])/gu;
const FIGURE = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const RANGE_AFTER = new RegExp(String.raw`^\s*(?:to|–|—|-|−)\s*(${FIGURE})`, 'iu');
const RANGE_BEFORE = new RegExp(String.raw`(${FIGURE})\s*(?:to|–|—|-|−)\s*$`, 'iu');

/** The figure as a number text: no thousands separators. */
export const plainFigure = (text: string): string => text.replaceAll(',', '');

/** What follows a figure: nothing that scales it, a magnitude word (after a space or a hyphen, or attached), or a scaler the document cannot hold. */
function readingAfter(text: string, end: number): Reading {
  const word = /^[\s\u00a0-]*(\p{L}+)/u.exec(text.slice(end))?.[1]?.toLowerCase();
  if (word === undefined) return 'bare';
  if (Object.hasOwn(MAGNITUDES, word)) return word as Magnitude;
  return UNKNOWN_SCALERS.has(word) ? 'unknown' : 'bare';
}

interface Occurrence {
  readonly reading: Reading;
  /** For one end of a range ("8 to 10 million"), the other end. The word after the range scales both ends. */
  readonly otherEnd?: string;
}

/** Every way the cited passages write `figure`. */
export function readingsOf(figure: string, quotes: readonly string[]): readonly Occurrence[] {
  const found: Occurrence[] = [];
  for (const quote of quotes)
    for (const match of quote.matchAll(NUMBER)) {
      if (plainFigure(match[0]) !== figure) continue;
      const end = match.index + match[0].length;
      const next = RANGE_AFTER.exec(quote.slice(end));
      const before = RANGE_BEFORE.exec(quote.slice(0, match.index));
      if (next?.[1] !== undefined)
        found.push({ reading: readingAfter(quote, end + next[0].length), otherEnd: plainFigure(next[1]) });
      else if (before?.[1] !== undefined)
        found.push({ reading: readingAfter(quote, end), otherEnd: plainFigure(before[1]) });
      else found.push({ reading: readingAfter(quote, end) });
    }
  return found;
}

/**
 * Whether a point agrees with the passages its item cites. A figure no passage states is the citation
 * rule's finding and passes here. With a `magnitude`, some passage must write that figure with exactly
 * that word. Without one, some passage must write it bare (so "17 million people" and "17 sheep" may be
 * given either way, but a figure that is only ever "8.3 million", "8.3bn", "8.3 crore" or a range end may
 * not be given bare). A range end passes only when the item itself states the other end.
 */
export function pointAgrees(
  point: { readonly value: string | number; readonly magnitude?: Magnitude | undefined },
  quotes: readonly string[],
  itemFigures: ReadonlySet<string>,
): boolean {
  const readings = readingsOf(plainFigure(String(point.value).trim()), quotes);
  if (readings.length === 0) return true;
  const stated = (entry: Occurrence): boolean => entry.otherEnd === undefined || itemFigures.has(entry.otherEnd);
  const wanted: Reading = point.magnitude ?? 'bare';
  return readings.some((entry) => entry.reading === wanted && stated(entry));
}

/** The words of a unit that carry meaning: letters only, short joining words and plurals set aside. */
const JOINING = new Set(['the', 'of', 'per', 'in', 'a', 'an', 'and', 'on', 'at', 'to']);
const stem = (word: string): string => word.replace(/s$/u, '');

function wordsOf(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replaceAll('’', "'")
      .match(/\p{L}+/gu) ?? []
  )
    .filter((word) => word.length > 1 && !JOINING.has(word))
    .map(stem);
}

/** Whether every meaningful word of a unit is written in a cited passage, so a unit the passages never name is refused. */
export function unitInPassages(unit: string, quotes: readonly string[]): boolean {
  const known = new Set(quotes.flatMap(wordsOf));
  return wordsOf(unit).every((word) => known.has(word));
}
