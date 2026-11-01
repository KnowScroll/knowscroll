/**
 * Scouts (v3 R-9, D-259 to D-261): when a member's scout may post a find, and what its owner may ask of it. Pure: facts in, a
 * decision out, with no database, clock, model or network. A scout is the member's own explicit choice: the topics it looks in
 * are picked from the room's topics by the member and never read from anything they did. Code chooses the asset and decides
 * whether the scout posts; a model only writes the short note, which code checks again before it is stored (the resident
 * feed's checks, `feed.ts`).
 */
import { dayStartOf, type FeedCounts, type FindCandidate } from './feed.js';

const DAY_MS = 86_400_000;

export const SCOUT_RULES = {
  /** The most topics one scout looks in. */
  interestsMax: 5,
  /** The most finds the scouts of one room post together on a UTC day, whoever sent them. */
  roomPostsPerDay: 5,
  /** A weekly scout rests for this many UTC days after a post, the day of the post included. */
  weeklyRestDays: 7,
  /** The most scouts one heartbeat looks at. */
  scoutsPerHeartbeat: 200,
} as const;

export type ScoutCadence = 'daily' | 'weekly';

export type InterestsProblem = 'empty' | 'too_many' | 'duplicate' | 'not_in_room';

/**
 * What is wrong with the topics a member chose, if anything: at least one, at most `interestsMax`, none twice, and every one a
 * topic of this room. The room's topics are the only list there is; nothing about the member fills it in.
 */
export function interestsProblem(
  interests: readonly string[],
  roomTopicIds: readonly string[],
): InterestsProblem | undefined {
  if (interests.length === 0) return 'empty';
  if (interests.length > SCOUT_RULES.interestsMax) return 'too_many';
  if (new Set(interests).size !== interests.length) return 'duplicate';
  return interests.every((interest) => roomTopicIds.includes(interest)) ? undefined : 'not_in_room';
}

/**
 * The start of the rest a scout is in: no earlier post than this blocks it. Daily is the start of the UTC day; weekly is six
 * days before it, so a post on a Monday rests until the next Monday.
 */
export function restStartOf(cadence: ScoutCadence, now: Date): Date {
  const today = dayStartOf(now);
  return cadence === 'daily' ? today : new Date(today.getTime() - (SCOUT_RULES.weeklyRestDays - 1) * DAY_MS);
}

/** When a scout that last posted at `lastPostAt` may post again; none when it has not posted or may post now. */
export function nextPostAfter(cadence: ScoutCadence, lastPostAt: Date | undefined): Date | undefined {
  if (lastPostAt === undefined) return undefined;
  const days = cadence === 'daily' ? 1 : SCOUT_RULES.weeklyRestDays;
  return new Date(dayStartOf(lastPostAt).getTime() + days * DAY_MS);
}

/** What counted turns the room has taken lately, and what its scouts have taken today. */
export interface ScoutCounts extends Pick<FeedCounts, 'roomLastHour' | 'roomToday'> {
  /** Finds the room's scouts have had counted since the UTC day began. */
  readonly scoutsToday: number;
}

export interface ScoutFacts {
  readonly now: Date;
  readonly room: {
    readonly open: boolean;
    /** Current members other than the owner whose AI level is not Off: the ones who read what a scout posts. */
    readonly listeners: number;
  };
  /** The scout as the room stores it now, under the room's lock; none when the owner took it back. */
  readonly scout:
    | {
        readonly cadence: ScoutCadence;
        readonly paused: boolean;
        /** A moderator stopped it. */
        readonly stopped: boolean;
      }
    | undefined;
  readonly owner: {
    /** The owner is a current member of the room. */
    readonly member: boolean;
    /** The owner has not paused recording (D-259). */
    readonly recording: boolean;
  };
  /** The asset code picked from the scout's own topics, or none when the room has seen everything they hold. */
  readonly candidate: FindCandidate | undefined;
  /** When this scout last had a find counted in this room. */
  readonly lastPostAt: Date | undefined;
  readonly counts: ScoutCounts;
}

/** The cap that refused a scout's find. */
export type ScoutCap = 'room_hour' | 'room_day' | 'scout_day';

/** Why a look ended with nothing to record: there was nothing to decide, or this scout may not post now. */
export type ScoutDrop =
  | 'room_closed'
  | 'no_scout'
  | 'paused'
  | 'stopped'
  | 'owner_gone'
  | 'recording_paused'
  | 'nobody_listening'
  | 'nothing_new'
  | 'resting';

export type ScoutDecision =
  | { readonly kind: 'drop'; readonly reason: ScoutDrop }
  /** A cap said no. Recorded as a quiet row: it posts nothing, shows nothing and calls no model. */
  | { readonly kind: 'refuse'; readonly cap: ScoutCap; readonly counts: ScoutCounts }
  | { readonly kind: 'post'; readonly counts: ScoutCounts };

/**
 * Whether this scout must stay silent whatever the library holds: a closed room, a scout that is gone, stopped or paused, an owner
 * who is no longer a member or who paused recording (D-259). Also read again under the room's lock just before a note is posted.
 */
export function scoutSilence(
  facts: Pick<ScoutFacts, 'room' | 'scout' | 'owner'>,
):
  | Extract<ScoutDrop, 'room_closed' | 'no_scout' | 'owner_gone' | 'stopped' | 'paused' | 'recording_paused'>
  | undefined {
  const { room, scout, owner } = facts;
  if (!room.open) return 'room_closed';
  if (scout === undefined) return 'no_scout';
  if (!owner.member) return 'owner_gone';
  if (scout.stopped) return 'stopped';
  if (scout.paused) return 'paused';
  return owner.recording ? undefined : 'recording_paused';
}

/**
 * Decides one look at one scout. The order is the policy: whatever silences a scout comes first, so its silence never costs a
 * call; then nobody listening, and no new asset (the library is finite, so a scout runs dry honestly); then its own rest; only
 * then the caps, which are the room's unprompted caps (shared with residents and the router) and the scouts' own five a day. A
 * refusal is recorded and quiet. Zero model calls come from every branch but `post`.
 */
export function routeScout(
  facts: ScoutFacts,
  caps: { readonly roomPerHour: number; readonly roomPerDay: number },
): ScoutDecision {
  const silence = scoutSilence(facts);
  if (silence !== undefined) return { kind: 'drop', reason: silence };
  const { room, scout, counts } = facts;
  if (room.listeners === 0) return { kind: 'drop', reason: 'nobody_listening' };
  if (facts.candidate === undefined) return { kind: 'drop', reason: 'nothing_new' };
  if (
    scout !== undefined &&
    facts.lastPostAt !== undefined &&
    facts.lastPostAt >= restStartOf(scout.cadence, facts.now)
  )
    return { kind: 'drop', reason: 'resting' };
  const cap = capBroken(counts, caps);
  return cap === undefined ? { kind: 'post', counts } : { kind: 'refuse', cap, counts };
}

function capBroken(
  counts: ScoutCounts,
  caps: { readonly roomPerHour: number; readonly roomPerDay: number },
): ScoutCap | undefined {
  if (counts.scoutsToday >= SCOUT_RULES.roomPostsPerDay) return 'scout_day';
  if (counts.roomLastHour >= caps.roomPerHour) return 'room_hour';
  if (counts.roomToday >= caps.roomPerDay) return 'room_day';
  return undefined;
}
