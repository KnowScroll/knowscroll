/**
 * Watch together's rules (R3 A2, D-256 to D-258): where a session is on the server's clock, when it is over, how many people to say are
 * watching and when a Reel may be started. Pure: the clock is an argument and nothing is read or written here. The server stores a
 * session's start and never anyone's position, so everything about *where* a session is comes from these functions and the clock;
 * a device that is told how long ago the session began plays that far in and counts on with its own steady clock.
 */

/** How long after the command the first frame is due, so the people already in the room can load the Reel. */
export const LEAD_IN_MS = 5_000;
/** "N watching" is a number only from this many people who joined and still have the room open. Below it, there is no number (D-257). */
export const COUNT_FROM = 3;
/** A Reel is started only while at least this many members have the room open: watching together needs someone to watch with. */
export const MIN_HERE_TO_START = 2;
/** The most sessions a room starts in one UTC day. */
export const SESSIONS_PER_ROOM_DAY = 20;
/** A session row is kept this many days after it ended (so "last on stage" can say when), then deleted by the room's first member command after that. */
export const ENDED_KEPT_DAYS = 7;
/** The longest Reel a session may carry; the migration's check is the same number. */
export const LONGEST_REEL_MS = 3_600_000;

/** When the first frame is due, from when the session was started. */
export const startsAtFrom = (startedAt: Date): Date => new Date(startedAt.getTime() + LEAD_IN_MS);

/** When the Reel's last frame is due. */
export const endsAt = (startsAt: Date, durationMs: number): Date => new Date(startsAt.getTime() + durationMs);

/** What a session is doing at one instant. Both numbers are on the server's clock. */
export type WatchPhase =
  | { readonly kind: 'starting'; readonly startsInMs: number }
  | { readonly kind: 'playing'; readonly elapsedMs: number }
  | { readonly kind: 'over' };

/** The phase at `now`: before the first frame is due, playing from it until the Reel's length has passed, then over. */
export function phaseAt(startsAt: Date, durationMs: number, now: Date): WatchPhase {
  const since = now.getTime() - startsAt.getTime();
  if (since < 0) return { kind: 'starting', startsInMs: -since };
  if (since >= durationMs) return { kind: 'over' };
  return { kind: 'playing', elapsedMs: since };
}

/**
 * The number "N watching" may carry, or none. A count of people who joined and still have the room open is said only from three: with
 * fewer it would name them, and a count is not a way to learn who is in (D-257).
 */
export const watchingShown = (joinedAndHere: number): number | undefined =>
  joinedAndHere >= COUNT_FROM ? joinedAndHere : undefined;

/** Why a Reel cannot be started now, as the use case asks it. The first reason that applies is the one said. */
export type StartBlock = 'room_paused' | 'stage_busy' | 'no_reels' | 'few_here' | 'too_many';

export interface StartFacts {
  readonly roomOpen: boolean;
  /** A session is live, or a Launch is in its lobby or running: the stage is taken. */
  readonly stageTaken: boolean;
  /** The room's topic has at least one library Reel. */
  readonly hasReels: boolean;
  /** Members with the room open now, the starter included. */
  readonly here: number;
  /** Sessions the room started since the day began. */
  readonly startedToday: number;
}

/** Whether a Reel may be started, and if not the first reason that stops it. */
export function startBlock(facts: StartFacts): StartBlock | undefined {
  if (!facts.roomOpen) return 'room_paused';
  if (facts.stageTaken) return 'stage_busy';
  if (!facts.hasReels) return 'no_reels';
  if (facts.here < MIN_HERE_TO_START) return 'few_here';
  if (facts.startedToday >= SESSIONS_PER_ROOM_DAY) return 'too_many';
  return undefined;
}

/** The start of the UTC day `at` falls on: the day a room's session cap counts from. */
export const dayStartOf = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** Sessions that ended before this moment are past their days and are deleted. */
export const keptUntil = (now: Date): Date => new Date(now.getTime() - ENDED_KEPT_DAYS * 86_400_000);

/** Whether the caller may stop the session for everyone: the member who shared it, or a moderator of the room. */
export const mayStop = (input: { readonly isStarter: boolean; readonly isModerator: boolean }): boolean =>
  input.isStarter || input.isModerator;
