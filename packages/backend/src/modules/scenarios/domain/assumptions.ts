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
 * One change of a step: the new assumption, and the earlier premise it takes the place of when it names it.
 * A change that names one replaces it whatever its own subject says; one that does not replaces only the
 * premise of its own subject, if there is one.
 */
export interface StepChange extends Assumption {
  readonly replaces?: string | undefined;
}

/** The subject whose premise a change takes over: the one it names, or its own. */
export const targetOf = (change: StepChange): string => wordsKey(change.replaces ?? change.subject);

/**
 * The assumptions that hold after a step: a change replaces the premise it names (or, naming none, the one of
 * its own subject), any other change is added. The replaced premise's place is kept, so a branch reads like its
 * ancestors.
 */
export function applyChanges(parent: readonly Assumption[], changes: readonly StepChange[]): Assumption[] {
  const next = [...parent];
  for (const change of changes) {
    const assumption = { subject: change.subject, statement: change.statement };
    const index = next.findIndex((existing) => wordsKey(existing.subject) === targetOf(change));
    if (index === -1) next.push(assumption);
    else next[index] = assumption;
  }
  return next;
}

/** Words too common to say what a statement is about. */
const FILLER = new Set(
  (
    'the and for with that this than then from into onto over under during each every all any some not but ' +
    'would will could should can may might shall are was were been being has have had does did its their there ' +
    'them they those these what which when where while who whom whose also only very more most much many such'
  ).split(' '),
);

/** What a statement is about: its words of three letters or more that are not filler, in singular form. */
function contentWords(text: string): Set<string> {
  return new Set(
    wordsKey(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !FILLER.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)),
  );
}

/** How alike two statements are, for a change that may be an adjusted premise: shared words, and their share of the shorter. */
const RESTATES_MIN_SHARED = 4;
const RESTATES_MIN_SHARE = 0.7;

/**
 * Whether a change says again, in other words, a premise that already holds: nearly every content word of
 * the shorter statement is in the other. Such a change adjusts that premise, so it must say which one it
 * replaces; left to stand beside it, the two would both reach the writer.
 */
export function restatesPremise(change: Assumption, premise: Assumption): boolean {
  const a = contentWords(change.statement);
  const b = contentWords(premise.statement);
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared >= RESTATES_MIN_SHARED && shared / Math.min(a.size, b.size) >= RESTATES_MIN_SHARE;
}
