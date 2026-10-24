import { ASSESSMENT_LIFETIME_MS } from './buffer.js';
import { refKey } from './policy.js';
import type { EncounterRef, EncounterSnapshot, JevCriteria } from './types.js';

/**
 * Most assessments kept for one person; the newest stay. Three calls of up to 20 candidates fit the
 * 30 minutes of one subject. It also keeps the assessments stored with a buffer inside that table's
 * 16 KiB check, whatever digits the model writes.
 */
export const JEV_POOL_LIMIT = 60;

/**
 * The soonest Jev may be asked again about the subject a person is on. The shortlist drifts by a
 * candidate or two with every swipe, so without this wait each swipe would pay for a call about
 * those few. Candidates that miss out rank as unassessed (neutral), never as bad.
 */
export const JEV_REFRESH_INTERVAL_MS = 10 * 60_000;

/** One stored judgement of a candidate, made while the person was on `subject`. */
export interface PooledAssessment extends EncounterRef, JevCriteria {
  readonly subject: string;
  readonly assessedAt: string;
}

/** A person's stored assessments. Entries made under another role version or model are not reused. */
export interface JevPool {
  readonly roleVersion: string;
  readonly model: string;
  readonly entries: readonly PooledAssessment[];
}

/**
 * What an assessment is about: the language and primary topic of the step the person was on. Jev
 * judges a candidate against "the learner's current interest as shown by the current step", and the
 * candidates of a vertical move are retrieved by the step's topics, so a judgement stays a fair
 * answer for any later step on the same subject. A step without topics is its own subject, so its
 * judgements are never lent to another step.
 *
 * Repetition of the step the person is on is not carried by a stored judgement: Composer excludes the
 * current explanation outright and recomputes recent repetition and novelty for every ranking.
 */
export function jevSubjectOf(source: EncounterSnapshot): string {
  const [primary] = source.topics
    .filter((topic) => topic.role !== 'incidental')
    .sort((a, b) => b.weight - a.weight || (a.topicId < b.topicId ? -1 : 1));
  const language = source.metadata.language;
  return primary ? `${language}|topic:${primary.topicId}` : `${language}|unit:${source.explanationUnitId}`;
}

const expiresAtMs = (entry: PooledAssessment): number => Date.parse(entry.assessedAt) + ASSESSMENT_LIFETIME_MS;

/** The pool's entries for `subject` that are still within their life and were made by this role version and model. */
export function usableAssessments(
  pool: JevPool | undefined,
  current: { readonly roleVersion: string; readonly model: string },
  subject: string,
  now: Date,
): readonly PooledAssessment[] {
  if (!pool || pool.roleVersion !== current.roleVersion || pool.model !== current.model) return [];
  return pool.entries.filter((entry) => entry.subject === subject && expiresAtMs(entry) > now.getTime());
}

export type AssessmentPlan =
  /** Nothing is sent: everything on the shortlist is assessed, or the subject was assessed a moment ago. */
  | { readonly kind: 'reuse'; readonly reason: 'nothing_new' | 'recently_assessed' }
  /** Send these shortlist candidates, which have no usable assessment. */
  | { readonly kind: 'ask'; readonly candidates: readonly EncounterSnapshot[] };

/**
 * Whether Jev is worth a call for this shortlist, and about which candidates. Only candidates
 * without a usable assessment are ever sent. A call also waits `JEV_REFRESH_INTERVAL_MS` after the
 * subject's newest assessment, so a swiper is charged at most one call per interval and subject.
 */
export function planAssessments(
  shortlist: readonly EncounterSnapshot[],
  usable: readonly PooledAssessment[],
  now: Date,
): AssessmentPlan {
  const assessed = new Set(usable.map(refKey));
  const candidates = shortlist.filter((candidate) => !assessed.has(refKey(candidate)));
  if (candidates.length === 0) return { kind: 'reuse', reason: 'nothing_new' };
  const newest = usable.reduce((latest, entry) => Math.max(latest, Date.parse(entry.assessedAt)), -Infinity);
  if (now.getTime() - newest < JEV_REFRESH_INTERVAL_MS) return { kind: 'reuse', reason: 'recently_assessed' };
  return { kind: 'ask', candidates };
}

/**
 * The pool after adding `added`: the old entries that are still within their life (none, when they
 * were made by another role version or model), minus any the new ones replace, plus the new ones,
 * newest first and cut at `JEV_POOL_LIMIT`.
 */
export function poolWith(existing: JevPool | undefined, added: JevPool, now: Date): JevPool {
  const kept =
    existing && existing.roleVersion === added.roleVersion && existing.model === added.model
      ? existing.entries.filter((entry) => expiresAtMs(entry) > now.getTime())
      : [];
  const replaced = new Set(added.entries.map((entry) => `${entry.subject}|${refKey(entry)}`));
  const entries = [...added.entries, ...kept.filter((entry) => !replaced.has(`${entry.subject}|${refKey(entry)}`))]
    .sort((a, b) => Date.parse(b.assessedAt) - Date.parse(a.assessedAt))
    .slice(0, JEV_POOL_LIMIT);
  return { roleVersion: added.roleVersion, model: added.model, entries };
}
