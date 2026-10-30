/**
 * The Stage manager (D-081, D-164): who may speak in a room on their own, and when. A pure function over facts
 * the caller read under the room lock, so every cap is exact and testable with a fixed clock. No model decides
 * who speaks. The speaking resident's own `nothing_to_add` is the only semantic judgement left, and it costs a
 * call only after this function said yes.
 */
import type { InhabitantId } from './contribution.js';
import type { SpeechTrigger } from './triggers.js';

/** Unprompted caps of one room (R3 question 3, D-068). Asked turns have their own bounds in `contribution.ts`. */
export const UNPROMPTED_CAPS = {
  /** One unprompted turn per this many human messages in the room since the last one. */
  humanMessagesPerTurn: 3,
  roomPerHour: 8,
  roomPerDay: 40,
  /** Per resident per hour. */
  residentPerHour: { explainer: 4, skeptic: 3 },
  /** The Skeptic speaks at most this often to one person's messages in an hour. */
  skepticPerPersonPerHour: 1,
} as const satisfies {
  humanMessagesPerTurn: number;
  roomPerHour: number;
  roomPerDay: number;
  residentPerHour: Record<InhabitantId, number>;
  skepticPerPersonPerHour: number;
};

const MINUTE = 60_000;

/** How long people get to answer first. Shorter when only the author is here, because nobody else can. */
export const WAITS = {
  question: { room: 4 * MINUTE, alone: 90_000 },
  claim: { room: 2 * MINUTE, alone: 90_000 },
  /** The one reply of the Skeptic to an Explainer that overstated. */
  reply: { room: MINUTE, alone: MINUTE },
} as const;

/** A trigger older than this is no longer worth an answer: the conversation has moved on. */
export const STALE_AFTER_MS = 30 * MINUTE;

/** The resident a trigger asks for. */
export function residentFor(trigger: SpeechTrigger): InhabitantId {
  return trigger === 'unanswered_question' ? 'explainer' : 'skeptic';
}

/** How long a trigger waits before a resident may speak to it. */
export function waitFor(trigger: SpeechTrigger, onlyAuthorHere: boolean): number {
  const wait =
    trigger === 'unanswered_question' ? WAITS.question : trigger === 'overstated_claim' ? WAITS.claim : WAITS.reply;
  return onlyAuthorHere ? wait.alone : wait.room;
}

/** The cap that refused a turn. */
export type RefusalCap = 'ratio' | 'room_hour' | 'room_day' | 'resident_hour' | 'person_hour';

/** Why a trigger was let go without a record: there was nothing to decide, or it no longer applies. */
export type DropReason =
  | 'decided'
  | 'room_closed'
  | 'no_resident'
  | 'stale'
  | 'nobody_listening'
  | 'kept_out'
  | 'answered'
  | 'chain'
  | 'newcomer';

/** The counts each cap compared, kept on the turn row. `humanSinceLastTurn` is absent before the room's first turn. */
export interface CapCounts {
  readonly humanSinceLastTurn?: number;
  readonly roomLastHour: number;
  readonly roomToday: number;
  readonly residentLastHour: number;
  readonly personLastHour: number;
}

export interface RouteFacts {
  readonly now: Date;
  readonly trigger: {
    readonly kind: SpeechTrigger;
    /** When the message that set it going was recorded. */
    readonly at: Date;
    /** The author keeps their messages out of what AI reads, so there is nothing for a resident to answer. */
    readonly authorKeptOut: boolean;
    /** The author's first message in this room. */
    readonly authorFirstMessage: boolean;
    /** A turn (allowed or refused) already exists for this message and trigger. */
    readonly decidedBefore: boolean;
  };
  readonly room: {
    readonly open: boolean;
    readonly residents: readonly InhabitantId[];
    /** Current members whose AI level is not Off. */
    readonly listeners: number;
  };
  /** Nobody but the author has the room open. */
  readonly onlyAuthorHere: boolean;
  /** Messages of the discussion after the one that set it going. */
  readonly after: { readonly byOthers: number; readonly byAi: number };
  /** Someone is typing here until this time. */
  readonly typingUntil: Date | undefined;
  readonly counts: CapCounts;
}

export type RouteDecision =
  /** Nothing to record. */
  | { readonly kind: 'drop'; readonly reason: DropReason }
  /** Not yet: look again at `until`. */
  | { readonly kind: 'wait'; readonly until: Date; readonly reason: 'too_early' | 'typing' }
  /** A cap said no. Recorded, posts nothing, shows nothing. */
  | { readonly kind: 'refuse'; readonly cap: RefusalCap; readonly counts: CapCounts }
  | { readonly kind: 'speak'; readonly inhabitant: InhabitantId; readonly counts: CapCounts };

/** The first cap this turn would break, if any. The one reply of the Skeptic to the Explainer is not counted against the ratio. */
function capBroken(kind: SpeechTrigger, counts: CapCounts, inhabitant: InhabitantId): RefusalCap | undefined {
  const { humanSinceLastTurn } = counts;
  if (
    kind !== 'answer_overstated' &&
    humanSinceLastTurn !== undefined &&
    humanSinceLastTurn < UNPROMPTED_CAPS.humanMessagesPerTurn
  )
    return 'ratio';
  if (counts.roomLastHour >= UNPROMPTED_CAPS.roomPerHour) return 'room_hour';
  if (counts.roomToday >= UNPROMPTED_CAPS.roomPerDay) return 'room_day';
  if (counts.residentLastHour >= UNPROMPTED_CAPS.residentPerHour[inhabitant]) return 'resident_hour';
  if (inhabitant === 'skeptic' && counts.personLastHour >= UNPROMPTED_CAPS.skepticPerPersonPerHour)
    return 'person_hour';
  return undefined;
}

/**
 * Decides one trigger at one moment. Order matters and is the policy: a trigger that no longer applies is let go
 * first (nothing recorded); then the wait people are owed and a typing hold (look again later); then the caps
 * (recorded as a quiet refusal); only then does a resident speak. Rules, in order:
 * - nothing to do when the room is closed, has no such resident, nobody listens, the author keeps messages out,
 *   or a turn was already decided for this message;
 * - a person (other than the author) or an AI already answered after the message: people are on it. For the one
 *   reply to an overstated Explainer, anything after it means the chain is over;
 * - the Skeptic never answers a newcomer's first message;
 * - people get `waitFor` first; a typing hold waits until it lapses;
 * - the caps of `UNPROMPTED_CAPS`.
 */
export function route(facts: RouteFacts): RouteDecision {
  const { trigger, room, after, counts } = facts;
  const inhabitant = residentFor(trigger.kind);
  if (trigger.decidedBefore) return { kind: 'drop', reason: 'decided' };
  if (!room.open) return { kind: 'drop', reason: 'room_closed' };
  if (!room.residents.includes(inhabitant)) return { kind: 'drop', reason: 'no_resident' };
  if (facts.now.getTime() - trigger.at.getTime() > STALE_AFTER_MS) return { kind: 'drop', reason: 'stale' };
  if (room.listeners === 0) return { kind: 'drop', reason: 'nobody_listening' };
  if (trigger.authorKeptOut) return { kind: 'drop', reason: 'kept_out' };
  if (after.byOthers > 0 || after.byAi > 0)
    return { kind: 'drop', reason: trigger.kind === 'answer_overstated' ? 'chain' : 'answered' };
  if (trigger.kind === 'overstated_claim' && trigger.authorFirstMessage) return { kind: 'drop', reason: 'newcomer' };

  const due = new Date(trigger.at.getTime() + waitFor(trigger.kind, facts.onlyAuthorHere));
  if (facts.now < due) return { kind: 'wait', until: due, reason: 'too_early' };
  if (facts.typingUntil !== undefined && facts.typingUntil > facts.now)
    return { kind: 'wait', until: facts.typingUntil, reason: 'typing' };

  const cap = capBroken(trigger.kind, counts, inhabitant);
  return cap === undefined ? { kind: 'speak', inhabitant, counts } : { kind: 'refuse', cap, counts };
}
