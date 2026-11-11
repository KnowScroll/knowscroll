import { z } from 'zod';

/**
 * Why Create started nothing for a brief. Four different answers an operator reads differently: the brief has no
 * production path at all (a Reel or a variant), the day's cap for that origin is used up, Create is switched off for
 * it, or every recipe that could serve it is already made or cannot be taken again.
 */
export type NotCommissionedReason = 'no_production_path' | 'cap_reached' | 'create_off' | 'no_recipe_left';

/** Why a missing-supply opportunity is not a brief Supply can serve. */
export type UnsupportedReason = 'topic_not_in_catalogue' | 'language_not_supported';

/**
 * The part of the Planner's opportunity that says what it wanted: the move, the explanation unit it aims at and the
 * model's own brief. It rides on the person's own demand row and nowhere else: never in a shared group or a canonical
 * brief, never evidence, never read by another person or another module. Supply still chooses what to make by code; a
 * later step may commission from it after checking it. Bounds match the Planner's opportunity schema, which already
 * checked the model's answer.
 */
export const PlannedIntentSchema = z.strictObject({
  version: z.literal('planned-intent.v1'),
  move: z.string().regex(/^[a-z][a-z_]{0,31}$/u),
  explanationUnitId: z.string().min(1).max(160),
  brief: z.string().min(1).max(800),
});
export type PlannedIntent = z.infer<typeof PlannedIntentSchema>;

/** The most bytes the database accepts for the intent's `jsonb` text (`supply_requests_planned_intent`). */
const PLANNED_INTENT_MAX_BYTES = 4096;
/** `jsonb` prints a space after every `:` and `,`; the four keys add seven bytes to `JSON.stringify`'s text. One more is margin. */
const JSONB_TEXT_EXTRA_BYTES = 8;
/** A UTF-16 surrogate half with no partner (in unicode mode a valid pair is one code point, so only a lone half matches). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

const storedBytes = (intent: PlannedIntent): number =>
  new TextEncoder().encode(JSON.stringify(intent)).length + JSONB_TEXT_EXTRA_BYTES;

/** Text `jsonb` can hold: no NUL (which it refuses) and no lone surrogate half. */
const storableText = (text: string): string => text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD');

/**
 * The intent as the database can keep it, or nothing. The Planner already checked the model's answer, but a plan must
 * never be rolled back for what only decorates a demand, so this is the last guard before the row: a value that fails
 * {@link PlannedIntentSchema} is dropped; text `jsonb` cannot hold is cleaned (NUL removed, a lone surrogate replaced); a
 * brief that would still exceed the column's byte bound (control characters escape to six bytes each) is cut from the
 * end until it fits, never past one character. Never throws.
 */
export function storablePlannedIntent(candidate: unknown): PlannedIntent | undefined {
  const parsed = PlannedIntentSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const explanationUnitId = storableText(parsed.data.explanationUnitId);
  let brief = storableText(parsed.data.brief);
  if (explanationUnitId === '' || brief === '') return undefined;
  let intent: PlannedIntent = { ...parsed.data, explanationUnitId, brief };
  while (storedBytes(intent) > PLANNED_INTENT_MAX_BYTES) {
    if (brief.length <= 1) return undefined;
    brief = storableText(brief.slice(0, Math.max(1, Math.floor(brief.length * 0.75))));
    if (brief === '') return undefined;
    intent = { ...intent, brief };
  }
  return intent;
}

/** What became of one missing-supply opportunity of an accepted plan. */
export type PlannedDemandOutcome =
  /** Reuse: admitted content the person has not met already fits. */
  (
    | { readonly kind: 'ready'; readonly requestId: string }
    /**
     * The person already has open planned demand for this brief (an earlier plan asked); nothing is added. `open` says
     * whether that demand is still waiting on production or already holds content that fits.
     */
    | { readonly kind: 'already_recorded'; readonly requestId: string; readonly open: 'deferred' | 'ready' }
    /** Join or Create: waits on the shared group, and a resolver job binds it when its production ends. */
    | { readonly kind: 'deferred'; readonly requestId: string; readonly joined: boolean }
    /** Nothing can produce it now. Nothing is stored; a later plan asks again. */
    | { readonly kind: 'not_commissioned'; readonly reason: NotCommissionedReason }
    /** Not a code-admitted catalogue brief. Nothing is stored. */
    | { readonly kind: 'unsupported'; readonly reason: UnsupportedReason }
  ) & {
    /**
     * Set when this call first closed an earlier demand of the same brief that had lost its resolver: it waited past
     * the wait limit and its poll chain never ended it.
     */
    readonly expiredRequestId?: string;
  };

/** The codes the outcome counters use. One outcome and, where it has one, one reason. `''` is no reason. */
export type PlannedOutcomeCode =
  'reused' | 'already_recorded' | 'commissioned' | 'joined' | 'not_commissioned' | 'unsupported' | 'expired';

/** What the counters add when a lost waiter is closed: one `expired` with the reason `no_resolver`. */
const EXPIRED = { outcome: 'expired', reason: 'no_resolver' } as const;

export interface PlannedOutcomeCount {
  readonly outcome: PlannedOutcomeCode;
  readonly reason: string;
  readonly total: number;
}

function codesOf(
  outcome: PlannedDemandOutcome,
): readonly { readonly outcome: PlannedOutcomeCode; readonly reason: string }[] {
  const own = ((): { readonly outcome: PlannedOutcomeCode; readonly reason: string } => {
    switch (outcome.kind) {
      case 'ready':
        return { outcome: 'reused', reason: '' };
      case 'already_recorded':
        return { outcome: 'already_recorded', reason: outcome.open === 'deferred' ? 'waiting' : 'reusable' };
      case 'deferred':
        return { outcome: outcome.joined ? 'joined' : 'commissioned', reason: '' };
      case 'not_commissioned':
        return { outcome: 'not_commissioned', reason: outcome.reason };
      case 'unsupported':
        return { outcome: 'unsupported', reason: outcome.reason };
    }
  })();
  return outcome.expiredRequestId === undefined ? [own] : [own, EXPIRED];
}

/**
 * The counters one accepted plan adds, grouped and sorted by outcome then reason. The order is fixed so that two
 * transactions that add to the same counter rows take their row locks in the same order and cannot deadlock.
 */
export function plannedOutcomeCounts(outcomes: readonly PlannedDemandOutcome[]): readonly PlannedOutcomeCount[] {
  const totals = new Map<string, PlannedOutcomeCount>();
  for (const outcome of outcomes)
    for (const code of codesOf(outcome)) {
      const key = `${code.outcome}\u0000${code.reason}`;
      totals.set(key, { ...code, total: (totals.get(key)?.total ?? 0) + 1 });
    }
  return [...totals.values()].sort(
    (a, b) =>
      (a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0) ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
}

/** The counter a resolver adds when it closes a planned demand that had lost its resolver (the plan path counts it too). */
export const LOST_WAITER_COUNT: PlannedOutcomeCount = { ...EXPIRED, total: 1 };

/**
 * How long past the wait limit a planned demand may stay open before it is called lost. A resolver whose poll chain is
 * alive closes a waiter at the limit, so a waiter still open ten minutes later has no resolver. The grace keeps a
 * slow but alive resolver from racing the expiry.
 */
export const LOST_WAITER_GRACE_MS = 10 * 60_000;

/** True when a waiter that began waiting at `waitingSince` has outlived `waitLimitMs` and the grace. */
export function isLostWaiter(waitingSince: Date, now: Date, waitLimitMs: number): boolean {
  return now.getTime() - waitingSince.getTime() >= waitLimitMs + LOST_WAITER_GRACE_MS;
}
