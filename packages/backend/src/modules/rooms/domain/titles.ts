/** The longest discussion title, in characters. */
export const TITLE_MAX_CHARS = 80;

/**
 * A discussion title made from some words (a content title, a shared card): whitespace and control
 * characters collapsed into single spaces and cut on a character boundary with an ellipsis. `fallback` is used
 * when nothing is left.
 */
export function titleFrom(words: string, fallback: string): string {
  // Whitespace and control characters alike separate words, so none glues two of them together.
  const cleaned = words.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (cleaned === '') return fallback;
  const characters = [...cleaned];
  return characters.length <= TITLE_MAX_CHARS
    ? cleaned
    : `${characters
        .slice(0, TITLE_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}
