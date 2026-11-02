import { numericTokens } from '../../text.js';
import { MAGNITUDES, type Magnitude } from '../../v2/blocks.js';
import { unstatedSpelledFigures } from './spelled-figures.js';

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

/** A times sign, as a passage writes one before a power of ten (a letter x only when it stands alone). */
const TIMES = String.raw`(?:[×*·⋅]|(?<!\p{L})[xX](?!\p{L}))`;
/** What makes a figure a power of ten's coefficient: "×10−7", "× 10^7", "x10⁷", "·10-7", "e-7", "E+30". */
const SCIENTIFIC_AFTER = new RegExp(
  String.raw`^\s*(?:${TIMES}\s*10\s*(?:\^\s*[-−+]?\s*\d|[-−+]?\d|[⁰¹²³⁴-⁹⁺⁻])|[eE][-+−]?\d)`,
  'u',
);
/** The "10" of a power of ten, and its exponent, which are numbers in their own right to the tokeniser. */
const POWER_BEFORE = new RegExp(String.raw`${TIMES}\s*10\s*\^?\s*[-−+]?\s*$`, 'u');
const TEN_BEFORE = new RegExp(String.raw`${TIMES}\s*$`, 'u');
const EXPONENT_AFTER = /^\s*(?:\^|[-−+]?\d|[⁰¹²³⁴-⁹⁺⁻])/u;

/**
 * What follows a figure: nothing that scales it, a magnitude word (after a space or a hyphen, or attached),
 * or a scaler the document cannot hold, which a power of ten is ("1.5×10−7 m" is not 1.5).
 */
function readingAfter(text: string, end: number): Reading {
  if (SCIENTIFIC_AFTER.test(text.slice(end))) return 'unknown';
  const word = /^[\s\u00a0-]*(\p{L}+)/u.exec(text.slice(end))?.[1]?.toLowerCase();
  if (word === undefined) return 'bare';
  if (Object.hasOwn(MAGNITUDES, word)) return word as Magnitude;
  return UNKNOWN_SCALERS.has(word) ? 'unknown' : 'bare';
}

interface Occurrence {
  readonly reading: Reading;
  /** A minus sign stands before the figure ("-3.8", "−3.8"); a hyphen or dash between two figures is a range, not a sign. */
  readonly negative: boolean;
  /** For one end of a range ("8 to 10 million"), the other end. The word after the range scales both ends. */
  readonly otherEnd?: string;
}

/** Whether a minus sign, and not a hyphen in a word or a dash in a range, stands just before the figure at `index`. */
function isNegative(text: string, index: number): boolean {
  if (!/[-\u2212\u2013]/u.test(text.charAt(index - 1))) return false;
  return index < 2 || !/[\p{L}\p{N}]/u.test(text.charAt(index - 2));
}

/** Every way the cited passages write `figure`. */
export function readingsOf(figure: string, quotes: readonly string[]): readonly Occurrence[] {
  const found: Occurrence[] = [];
  for (const quote of quotes)
    for (const match of quote.matchAll(NUMBER)) {
      if (plainFigure(match[0]) !== figure) continue;
      const end = match.index + match[0].length;
      const negative = isNegative(quote, match.index);
      // The "10" and the exponent of a power of ten are part of the scaled figure, never a figure of their own.
      const lead = quote.slice(0, match.index);
      if (
        POWER_BEFORE.test(lead) ||
        (figure === '10' && TEN_BEFORE.test(lead) && EXPONENT_AFTER.test(quote.slice(end)))
      ) {
        found.push({ reading: 'unknown', negative });
        continue;
      }
      const next = RANGE_AFTER.exec(quote.slice(end));
      const before = RANGE_BEFORE.exec(quote.slice(0, match.index));
      if (next?.[1] !== undefined)
        found.push({ reading: readingAfter(quote, end + next[0].length), otherEnd: plainFigure(next[1]), negative });
      else if (before?.[1] !== undefined)
        found.push({ reading: readingAfter(quote, end), otherEnd: plainFigure(before[1]), negative });
      else found.push({ reading: readingAfter(quote, end), negative });
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

/** Digits the matcher above does not read: fractions such as ½, superscripts and the digits of other scripts. */
const OTHER_NUMERALS = /\p{N}/gu;
const ASCII_DIGITS = /[0-9]/u;

/**
 * The figures of a text that the passages do not state the way the text writes them (D-208, D-302), in order and without
 * repeats. This is the rule for a figure in prose, as `pointAgrees` is for a point of a scale or a chart: a figure is
 * the number as a person reads it (thousands separators dropped, the decimal part kept, a minus sign kept: "-3.8" is not
 * "3.8"), and it is stated when some passage writes that same figure the same way: with the same word after it
 * ("1.25 million" is not "1.25"), the same other end of a range, or the same notation. A figure no passage holds is
 * unstated, and so is one that the passages only ever write another way. A numeral the matcher cannot read is stated only when
 * a passage holds it character for character, so it cannot slip past as a word.
 *
 * A number written in words is a figure too when it is a magnitude word (hundred to trillion: "a million") or number words
 * with a unit ("one point two five million metres"): it is stated only when a passage holds the same words
 * (`unstatedSpelledFigures`). "One clear example" and "two bulges" are words.
 */
export function unstatedFigures(text: string, passages: readonly string[]): readonly string[] {
  const unstated = new Set<string>();
  for (const match of text.matchAll(NUMBER)) {
    const figure = plainFigure(match[0]);
    const stated = readingsOf(figure, passages);
    const unmatched = readingsOf(figure, [text]).filter(
      (way) =>
        !stated.some(
          (entry) =>
            entry.reading === way.reading && entry.otherEnd === way.otherEnd && entry.negative === way.negative,
        ),
    );
    for (const way of unmatched) unstated.add(way.negative ? `-${figure}` : figure);
  }
  for (const [start, end] of numericTokens(text)) {
    const token = text.slice(start, end);
    for (const numeral of token.match(OTHER_NUMERALS) ?? [])
      if (!ASCII_DIGITS.test(numeral) && !passages.some((passage) => passage.includes(numeral))) unstated.add(numeral);
  }
  for (const spelled of unstatedSpelledFigures(text, passages)) unstated.add(spelled);
  return [...unstated];
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
