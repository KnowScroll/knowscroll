import {
  applyChanges,
  MAX_ASSUMPTIONS,
  MAX_CHANGES,
  MAX_KEPT,
  repeatsSubject,
  wordsKey,
  type Assumption,
} from './assumptions.js';

export type ScenarioKind = 'what_if' | 'perspective';

/** What a new branch inherits from the node it continues, or from the thread root (nothing, and not hypothetical). */
export interface ParentFacts {
  readonly hypothetical: boolean;
  readonly assumptions: readonly Assumption[];
}
export const ROOT_PARENT: ParentFacts = { hypothetical: false, assumptions: [] };

/** What a member (or the model, for them) asks of one step. */
export interface StepRequest {
  readonly kind: ScenarioKind;
  readonly changes: readonly Assumption[];
  readonly kept: readonly Assumption[];
  readonly lens?: string | undefined;
}

export type StepRefusal =
  | 'what_if_needs_a_change'
  | 'what_if_has_no_lens'
  | 'perspective_needs_a_lens'
  | 'perspective_changes_nothing'
  | 'too_many_changes'
  | 'too_many_kept'
  | 'repeated_change'
  | 'repeated_kept'
  | 'kept_contradicts_change'
  | 'kept_contradicts_premise'
  | 'too_many_assumptions';

/** A checked branch step: what it changes, keeps and names, and what holds after it. */
export interface Step {
  readonly kind: ScenarioKind;
  readonly changes: readonly Assumption[];
  readonly kept: readonly Assumption[];
  readonly lens?: string;
  /** What holds after this step: the parent's assumptions with the changes applied. */
  readonly assumptions: readonly Assumption[];
  /** True for every what-if, and for everything below one, even a step that only changes the lens. */
  readonly hypothetical: boolean;
}

export type StepOutcome =
  { readonly ok: true; readonly step: Step } | { readonly ok: false; readonly refusal: StepRefusal };

/**
 * Checks one step against what its parent holds (blueprint §14: `A_child = ApplyChange(A_parent,
 * RequestedChange)`). A what-if makes one or two explicit changes and may declare what it keeps; it
 * can neither keep what it changes nor push the premises past what a Scroll can state. A perspective
 * changes nothing and names a lens, so its assumptions are its parent's exactly. A branch below a
 * hypothetical stays hypothetical whatever its own kind. Pure and deterministic.
 */
export function planStep(parent: ParentFacts, request: StepRequest): StepOutcome {
  if (request.kind === 'perspective') {
    if (request.lens === undefined) return { ok: false, refusal: 'perspective_needs_a_lens' };
    if (request.changes.length > 0 || request.kept.length > 0)
      return { ok: false, refusal: 'perspective_changes_nothing' };
    return {
      ok: true,
      step: {
        kind: 'perspective',
        changes: [],
        kept: [],
        lens: request.lens,
        assumptions: parent.assumptions,
        hypothetical: parent.hypothetical,
      },
    };
  }
  if (request.lens !== undefined) return { ok: false, refusal: 'what_if_has_no_lens' };
  if (request.changes.length === 0) return { ok: false, refusal: 'what_if_needs_a_change' };
  if (request.changes.length > MAX_CHANGES) return { ok: false, refusal: 'too_many_changes' };
  if (request.kept.length > MAX_KEPT) return { ok: false, refusal: 'too_many_kept' };
  if (repeatsSubject(request.changes)) return { ok: false, refusal: 'repeated_change' };
  if (repeatsSubject(request.kept)) return { ok: false, refusal: 'repeated_kept' };
  const kept = keptBy(parent, request);
  if (!kept.ok) return kept;
  const assumptions = applyChanges(parent.assumptions, request.changes);
  if (assumptions.length > MAX_ASSUMPTIONS) return { ok: false, refusal: 'too_many_assumptions' };
  return {
    ok: true,
    step: { kind: 'what_if', changes: request.changes, kept: kept.items, assumptions, hypothetical: true },
  };
}

/**
 * What a what-if really keeps. A kept subject may not be one this step changes, and may not be one an
 * earlier branch already assumes in other words (the two would disagree in one Scroll). One that
 * restates a premise that already holds, in the same words, adds nothing: it is listed once, among the
 * assumptions, and dropped from `kept`.
 */
function keptBy(
  parent: ParentFacts,
  request: StepRequest,
):
  { readonly ok: true; readonly items: readonly Assumption[] } | { readonly ok: false; readonly refusal: StepRefusal } {
  const changed = new Set(request.changes.map((change) => wordsKey(change.subject)));
  const held = new Map(parent.assumptions.map((premise) => [wordsKey(premise.subject), wordsKey(premise.statement)]));
  const items: Assumption[] = [];
  for (const kept of request.kept) {
    const subject = wordsKey(kept.subject);
    if (changed.has(subject)) return { ok: false, refusal: 'kept_contradicts_change' };
    const premise = held.get(subject);
    if (premise === undefined) items.push(kept);
    else if (premise !== wordsKey(kept.statement)) return { ok: false, refusal: 'kept_contradicts_premise' };
  }
  return { ok: true, items };
}

/**
 * The text whose SHA-256 is the meaning of a branch within its thread: the parent, the kind and what
 * it changes or its lens, in a fixed order. What it declares kept does not change the idea, so two
 * members who ask for the same change get one branch. The caller hashes it.
 */
export function meaningOf(parentNodeId: string | null, step: Step): string {
  const changes = step.changes
    .map((change) => [wordsKey(change.subject), wordsKey(change.statement)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([parentNodeId, step.kind, changes, step.lens === undefined ? null : wordsKey(step.lens)]);
}
