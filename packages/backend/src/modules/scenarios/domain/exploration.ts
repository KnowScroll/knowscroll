import {
  applyChanges,
  MAX_ASSUMPTIONS,
  MAX_CHANGES,
  MAX_KEPT,
  repeatsSubject,
  sharesContentWord,
  targetOf,
  wordsKey,
  type Assumption,
  type StepChange,
} from './assumptions.js';

export type ScenarioKind = 'what_if' | 'perspective';

/** What a new branch inherits from the node it continues, or from the thread root (nothing, and not hypothetical). */
export interface ParentFacts {
  readonly hypothetical: boolean;
  /** The Planner marked a premise speculative somewhere on the way here: it stays marked below. */
  readonly speculative: boolean;
  readonly assumptions: readonly Assumption[];
}
export const ROOT_PARENT: ParentFacts = { hypothetical: false, speculative: false, assumptions: [] };

/** What a member (or the model, for them) asks of one step. */
export interface StepRequest {
  readonly kind: ScenarioKind;
  readonly changes: readonly StepChange[];
  readonly kept: readonly Assumption[];
  readonly lens?: string | undefined;
  /** The Planner flagged this direction as speculative and the member confirmed it. */
  readonly speculative?: boolean | undefined;
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
  | 'replaces_unknown_premise'
  | 'replaces_unrelated_premise'
  | 'replaces_conflict'
  | 'too_many_assumptions';

/** A checked branch step: what it changes, keeps and names, and what holds after it. */
export interface Step {
  readonly kind: ScenarioKind;
  readonly changes: readonly Assumption[];
  readonly kept: readonly Assumption[];
  readonly lens?: string;
  /** What holds after this step: the parent's assumptions with the changes applied. */
  readonly assumptions: readonly Assumption[];
  /** The subjects of the premises a change took over under another subject, sorted: part of what the step means. */
  readonly replaced: readonly string[];
  /** True for every what-if, and for everything below one, even a step that only changes the lens. */
  readonly hypothetical: boolean;
  /** Flagged speculative here, or by an ancestor: a perspective below a speculative what-if is still reasoning from it. */
  readonly speculative: boolean;
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
        replaced: [],
        hypothetical: parent.hypothetical,
        speculative: parent.speculative,
      },
    };
  }
  if (request.lens !== undefined) return { ok: false, refusal: 'what_if_has_no_lens' };
  if (request.changes.length === 0) return { ok: false, refusal: 'what_if_needs_a_change' };
  if (request.changes.length > MAX_CHANGES) return { ok: false, refusal: 'too_many_changes' };
  if (request.kept.length > MAX_KEPT) return { ok: false, refusal: 'too_many_kept' };
  if (repeatsSubject(request.changes)) return { ok: false, refusal: 'repeated_change' };
  if (repeatsSubject(request.kept)) return { ok: false, refusal: 'repeated_kept' };
  const replacement = replacementRefusal(parent, request.changes);
  if (replacement !== undefined) return { ok: false, refusal: replacement };
  const kept = keptBy(parent, request);
  if (!kept.ok) return kept;
  const assumptions = applyChanges(parent.assumptions, request.changes);
  if (assumptions.length > MAX_ASSUMPTIONS) return { ok: false, refusal: 'too_many_assumptions' };
  return {
    ok: true,
    step: {
      kind: 'what_if',
      changes: request.changes.map(({ subject, statement }) => ({ subject, statement })),
      kept: kept.items,
      assumptions,
      replaced: request.changes
        .filter((change) => change.replaces !== undefined && targetOf(change) !== wordsKey(change.subject))
        .map(targetOf)
        .sort(),
      hypothetical: true,
      speculative: parent.speculative || request.speculative === true,
    },
  };
}

/**
 * Whether the changes that name a premise to replace can all be applied. Each names a premise that holds, and under
 * another subject shares at least a content word with it (a change is not allowed to drop a premise it has nothing to
 * do with); no premise is replaced twice, and a change that moves to a new subject does not land on a subject another
 * premise or change already has (the two would silently become one).
 */
function replacementRefusal(parent: ParentFacts, changes: readonly StepChange[]): StepRefusal | undefined {
  const held = new Map(parent.assumptions.map((premise) => [wordsKey(premise.subject), premise]));
  const taken = new Set<string>();
  for (const change of changes) {
    if (change.replaces === undefined) continue;
    const target = targetOf(change);
    const premise = held.get(target);
    if (premise === undefined) return 'replaces_unknown_premise';
    if (target !== wordsKey(change.subject) && !sharesContentWord(change, premise)) return 'replaces_unrelated_premise';
    if (taken.has(target)) return 'replaces_conflict';
    taken.add(target);
  }
  for (const change of changes) {
    const subject = wordsKey(change.subject);
    if (change.replaces === undefined ? taken.has(subject) : subject !== targetOf(change) && held.has(subject))
      return 'replaces_conflict';
  }
  return undefined;
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
  const changed = new Set(request.changes.flatMap((change) => [wordsKey(change.subject), targetOf(change)]));
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
 * The text whose SHA-256 is the meaning of a branch within its thread: the parent, the kind, what it
 * changes (and which premises it takes over under another subject) or its lens, and whether it is
 * speculative, in a fixed order. What it declares kept does not change the idea, so two members who ask for
 * the same change get one branch. The flag is part of it: a branch that says "not established science" and
 * one that does not are different Scrolls, and one is never reused for the other. The caller hashes it.
 */
export function meaningOf(parentNodeId: string | null, step: Step): string {
  const changes = step.changes
    .map((change) => [wordsKey(change.subject), wordsKey(change.statement)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    parentNodeId,
    step.kind,
    changes,
    step.lens === undefined ? null : wordsKey(step.lens),
    step.replaced,
    step.speculative,
  ]);
}
