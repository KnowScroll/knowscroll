/**
 * The answer check of a v2 library Scroll (D-198): after the writer's answer passes the validator, a model
 * is asked whether each call's answer key agrees with the call's own words. It only proposes; code decides
 * what a verdict changes. Pure; the production job asks the model and records what it said.
 */

/** What the checker said about one call. `problem` is present exactly when the call is flagged. */
export interface CallVerdict {
  /** The call's id in the document (`c1`, `final`...). */
  readonly id: string;
  readonly consistent: boolean;
  /** One or two plain sentences: what disagrees with what. Operator-only; never shown to a reader. */
  readonly problem?: string;
}

/**
 * One answer check as the production job records it. `unchecked` means the checker gave no usable answer
 * (it failed, was refused or sent a reply that stayed unusable after its one repair), so nothing is known
 * about the calls; `code` says why. A paused check is not recorded: the job waits and asks again.
 */
export interface AnswerCheckRecord {
  /** The writer's draft that was checked: 1, or 2 when the writer repaired the first after a flag. */
  readonly draft: 1 | 2;
  readonly kind: 'checked' | 'unchecked';
  readonly verdicts?: readonly CallVerdict[];
  readonly code?: string;
}

/** Whether the checker found anything in the calls it was shown. */
export function flaggedCalls(verdicts: readonly CallVerdict[]): readonly CallVerdict[] {
  return verdicts.filter((verdict) => !verdict.consistent);
}

/**
 * What the operator is told about a job's answer check. `passed`: every call was consistent at the first
 * draft. `repaired`: the first draft was flagged, the writer repaired it once and the repair was
 * consistent. `flagged`: the Scroll was refused because a flag stood and the one repair was spent or did
 * not clear it. `unchecked`: the checker gave no usable answer, so the Scroll waits for a read with no
 * verdict at all.
 */
export type AnswerCheckSummary =
  | { readonly outcome: 'passed'; readonly calls: number }
  | { readonly outcome: 'repaired'; readonly calls: number; readonly firstDraftFlags: readonly CallVerdict[] }
  | {
      readonly outcome: 'flagged';
      readonly flags: readonly CallVerdict[];
      readonly firstDraftFlags: readonly CallVerdict[];
    }
  | { readonly outcome: 'unchecked'; readonly code: string; readonly firstDraftFlags: readonly CallVerdict[] };

/**
 * Reads a job's checks, in draft order, into the one thing the operator needs. `undefined` when no check
 * ran for the job: it is a v1 Scroll, or it was produced before the check existed.
 */
export function summariseAnswerChecks(records: readonly AnswerCheckRecord[]): AnswerCheckSummary | undefined {
  const last = records.at(-1);
  if (last === undefined) return undefined;
  const firstDraft = records.find((record) => record.draft === 1);
  const firstDraftFlags =
    last.draft === 2 && firstDraft?.verdicts !== undefined ? flaggedCalls(firstDraft.verdicts) : [];
  if (last.kind === 'unchecked') return { outcome: 'unchecked', code: last.code ?? 'unchecked', firstDraftFlags };
  const verdicts = last.verdicts ?? [];
  const flags = flaggedCalls(verdicts);
  if (flags.length > 0) return { outcome: 'flagged', flags, firstDraftFlags };
  return firstDraftFlags.length > 0
    ? { outcome: 'repaired', calls: verdicts.length, firstDraftFlags }
    : { outcome: 'passed', calls: verdicts.length };
}
