/** Rules of assumptions that need no database, clock or crypto (blueprint §14). */

/** One thing a branch changes or holds: a short subject and a self-contained statement. */
export interface Assumption {
  readonly subject: string;
  readonly statement: string;
}

/** What one step may change, may declare kept, and how many assumptions can hold together after it. */
export const MAX_CHANGES = 2;
export const MAX_KEPT = 3;
export const MAX_ASSUMPTIONS = 4;

/** How subjects and statements compare: case, spacing and compatibility forms do not make a new one. */
export const wordsKey = (subject: string): string =>
  subject.normalize('NFKC').toLowerCase().replaceAll(/\s+/gu, ' ').trim();

/** Whether a list names the same subject twice. */
export const repeatsSubject = (items: readonly Assumption[]): boolean =>
  new Set(items.map((item) => wordsKey(item.subject))).size !== items.length;

/**
 * The assumptions that hold after a step: a change to a subject the parent already assumes replaces
 * it, any other change is added. The parent's order is kept, so a branch reads like its ancestors.
 */
export function applyChanges(parent: readonly Assumption[], changes: readonly Assumption[]): Assumption[] {
  const next = [...parent];
  for (const change of changes) {
    const index = next.findIndex((existing) => wordsKey(existing.subject) === wordsKey(change.subject));
    if (index === -1) next.push(change);
    else next[index] = change;
  }
  return next;
}
