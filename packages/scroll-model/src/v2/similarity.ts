/**
 * How alike two short texts are, for refusing a question that asks again what an earlier question
 * already asked (D-126). Deterministic and locale-free: the content words of each text (letters and
 * digits, lower case, no filler words, a plural cut back to its singular) are compared as sets, and
 * the score is the share of all content words that both texts use.
 */

/** Two texts at or above this score restate one another. Measured on question-length texts; see `similarity.test.ts`. */
export const RESTATEMENT_THRESHOLD = 0.6;

/** A text with fewer content words than this is too short to judge: a lone "Yes" is not a restatement. */
export const MIN_CONTENT_WORDS = 3;

const FILLER = new Set(
  (
    'a an the of to in on at by for with from as into over about is are was were be been it its this that these those ' +
    'and or but if so than then what which who whom why how when where does do did will would can could should ' +
    'may might you your we our they their there'
  ).split(' '),
);

/** A plural reduced to its singular; words that merely end in "s" (class, bus, this) are left alone. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/u.test(word) ? word.slice(0, -1) : word;
}

/** The distinct content words of a text. */
export function contentWords(text: string): ReadonlySet<string> {
  const words =
    text
      .normalize('NFC')
      .toLowerCase()
      .replace(/['’]/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => !FILLER.has(word)).map(singular));
}

/**
 * The share of content words two texts have in common (0 to 1), or `undefined` when either has too
 * few content words to judge.
 */
export function contentOverlap(first: string, second: string): number | undefined {
  const left = contentWords(first);
  const right = contentWords(second);
  if (left.size < MIN_CONTENT_WORDS || right.size < MIN_CONTENT_WORDS) return undefined;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** True when the later text says what the earlier one said, in other words or none. */
export function restates(earlier: string, later: string): boolean {
  const overlap = contentOverlap(earlier, later);
  return overlap !== undefined && overlap >= RESTATEMENT_THRESHOLD;
}
