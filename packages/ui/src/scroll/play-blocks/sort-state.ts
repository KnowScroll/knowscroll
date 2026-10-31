/** The order a person has put a sort's items in: indexes into the block's `items`, one per place. */
export type Attempt = readonly number[];

/** The items as shown: place n holds item n. */
export const shownOrder = (count: number): Attempt => Array.from({ length: count }, (_, index) => index);

/** The attempt after the item in `place` moves `by` places (-1 up, +1 down). Past either end nothing moves. */
export function moved(attempt: Attempt, place: number, by: -1 | 1): Attempt {
  const target = place + by;
  if (place < 0 || place >= attempt.length || target < 0 || target >= attempt.length) return attempt;
  const next = [...attempt];
  [next[place], next[target]] = [next[target] ?? 0, next[place] ?? 0];
  return next;
}
