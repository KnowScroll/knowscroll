/** The longest discussion title, in characters. */
export const TITLE_MAX_CHARS = 80;

/**
 * A discussion title made from some words (a content title, a shared card): whitespace collapsed,
 * control characters dropped and cut on a character boundary with an ellipsis. `fallback` is used
 * when nothing is left.
 */
export function titleFrom(words: string, fallback: string): string {
  const cleaned = [...words]
    .filter((character) => {
      const point = character.codePointAt(0)!;
      return point >= 32 && (point < 127 || point > 159);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return fallback;
  const characters = [...cleaned];
  return characters.length <= TITLE_MAX_CHARS
    ? cleaned
    : `${characters
        .slice(0, TITLE_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}
