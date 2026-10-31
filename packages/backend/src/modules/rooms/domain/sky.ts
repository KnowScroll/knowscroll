import { ROOM_NAMING_HOURS, ROOM_STARS_PER_CONSTELLATION, type RoomSky, type RoomStarAct } from '@knowscroll/contracts';

/**
 * The room's sky: what earns a star, when one is refused, how stars become a constellation and how a constellation is
 * named (D-174, D-175). Pure: no database, clock or crypto beyond the arguments. Stars are room-level facts that name no
 * person; a person's own acts only decide whether a star is earned.
 */

/** The most stars a room earns on one UTC day unless a world configures another number (R3: nobody can farm the sky). */
export const STARS_PER_DAY_DEFAULT = 3;

/** A debate earns its star only when at least this many different people voted: a vote of one is not a room's act. */
export const DEBATE_MIN_VOTERS = 2;

export type StarDecision = 'award' | 'duplicate' | 'day_full';

/**
 * Whether an act earns a star now. The same act (same source) earns once, however often its command is retried or how many
 * people finish it together; the day's cap holds whatever acts are left over, and an act that met a full day does not
 * come back.
 */
export function starDecision(input: {
  readonly alreadyAwarded: boolean;
  readonly earnedToday: number;
  readonly perDay: number;
}): StarDecision {
  if (input.alreadyAwarded) return 'duplicate';
  return input.earnedToday >= input.perDay ? 'day_full' : 'award';
}

/** The facts of a Useful mark that decide whether the message it marks is a human answer worth a star. */
export interface UsefulStarFacts {
  readonly discussion: {
    readonly kind: 'general' | 'topic' | 'today';
    readonly tag: 'question' | 'debate' | 'explainer' | 'share' | null;
    readonly startedByAccountId: string | null;
  };
  /** The author of the marked message; none for an AI resident, a tombstone or a card. */
  readonly authorAccountId: string | null;
  readonly giverAccountId: string;
  /** The message has words of its own (not a card, a topic card or a removed message). */
  readonly hasWords: boolean;
}

/**
 * A human answer marked Useful by someone else. The answer is a person's words in today's channel, or in a topic tagged a
 * question by someone other than the person who asked it. A resident's words never earn (an AI is not a person who
 * answered), nor does a mark on one's own message, a card, General chat or a debate.
 */
export function usefulEarnsStar(facts: UsefulStarFacts): boolean {
  if (facts.authorAccountId === null || !facts.hasWords) return false;
  if (facts.authorAccountId === facts.giverAccountId) return false;
  const { discussion } = facts;
  if (discussion.kind === 'today') return true;
  return (
    discussion.kind === 'topic' &&
    discussion.tag === 'question' &&
    discussion.startedByAccountId !== null &&
    discussion.startedByAccountId !== facts.authorAccountId
  );
}

/**
 * The constellation a new star belongs to, from how many stars the room has earned before it: the first seven are
 * constellation 1, the next seven constellation 2.
 */
export const constellationOfStar = (starsBefore: number): number =>
  Math.floor(starsBefore / ROOM_STARS_PER_CONSTELLATION) + 1;

/** Whether the star just earned (the room now has `starsNow`) finished a constellation. */
export const finishesConstellation = (starsNow: number): boolean =>
  starsNow > 0 && starsNow % ROOM_STARS_PER_CONSTELLATION === 0;

/**
 * The sky as a station draws it, from the room's star count and what its constellations are named. `lit` is the stars of
 * the constellation being made: a finished one stays at seven until the next star starts the next, so a room that just
 * finished shows a full one.
 */
export function skyOf(input: {
  readonly stars: number;
  /** The latest finished constellation has a name. */
  readonly latestIsNamed: boolean;
  /** The name of the room's latest named constellation, if any. */
  readonly latestName: string | undefined;
}): RoomSky {
  const finished = Math.floor(input.stars / ROOM_STARS_PER_CONSTELLATION);
  const lit = input.stars === 0 ? 0 : ((input.stars - 1) % ROOM_STARS_PER_CONSTELLATION) + 1;
  const full = lit === ROOM_STARS_PER_CONSTELLATION;
  return {
    lit,
    of: ROOM_STARS_PER_CONSTELLATION,
    state: !full ? 'forming' : input.latestIsNamed ? 'named' : 'naming',
    finished,
    ...(input.latestName === undefined ? {} : { constellationName: input.latestName }),
  };
}

/** The act's own words for a person tapping a star: fixed, never from a model or a member. */
export const STAR_ACT_WORDS: Record<RoomStarAct, string> = {
  answer_useful: 'An answer someone found useful',
  debate_closed: 'A debate closed by vote',
  daily_solved: 'The day’s Spot the flaw found',
};

// --- Naming ---------------------------------------------------------------------------------

/** When a constellation's name vote closes, from when its seventh star landed. */
export const namingClosesAt = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + ROOM_NAMING_HOURS * 3_600_000);

/**
 * Names a constellation may be offered under: short, plain, and shaped like the design's own ("The Press"). Lists are by
 * library system so a room's names fit its topic; a system without a list uses the shared one. Chosen by code from fixed
 * lists, never by a model, and never typed by a member.
 */
const NAMES: Readonly<Record<string, readonly string[]>> = {
  space: ['The Lantern', 'The Long Way', 'The Kite', 'The Quiet Sun', 'The Ferry', 'The Compass'],
  earth: ['The Tilt', 'The Tide', 'The Long Year', 'The Weather Vane', 'The Ridge', 'The Thaw'],
  'human-body': ['The Heartbeat', 'The Loom', 'The Lantern', 'The Pulse', 'The Spiral', 'The Garden'],
  'machine-learning': ['The Gradient', 'The Loom', 'The Lantern', 'The Relay', 'The Net', 'The Climb'],
  computing: ['The Relay', 'The Gate', 'The Loom', 'The Lantern', 'The Stack', 'The Switch'],
  history: ['The Ledger', 'The Long Road', 'The Lantern', 'The Bridge', 'The Archive', 'The Ember'],
};
const SHARED_NAMES: readonly string[] = [
  'The Lantern',
  'The Long Way',
  'The Kite',
  'The Loom',
  'The Bridge',
  'The Ember',
];

/**
 * Three different names for constellation `no`, from the room's topic list, starting at a place the room and the number
 * choose and skipping any name the room already uses, so a room's constellations do not repeat a name while others remain.
 */
export function constellationCandidates(input: {
  readonly topicId: string;
  readonly roomId: string;
  readonly no: number;
  readonly used: readonly string[];
}): readonly [string, string, string] {
  const list = NAMES[input.topicId] ?? SHARED_NAMES;
  const fresh = list.filter((name) => !input.used.includes(name));
  const pool = fresh.length >= 3 ? fresh : list;
  const seed = Number.parseInt(input.roomId.replaceAll('-', '').slice(-8), 16) + input.no * 7;
  const start = seed % pool.length;
  return [pool[start]!, pool[(start + 1) % pool.length]!, pool[(start + 2) % pool.length]!];
}

/**
 * The name a vote settles on: the candidate with the most votes, a tie going to the earlier one, and no votes at all to the
 * first. A rule anyone can compute from the counts, so no one decides a name by being last to look.
 */
export function winningCandidate(votes: readonly [number, number, number]): 0 | 1 | 2 {
  let best: 0 | 1 | 2 = 0;
  for (const index of [1, 2] as const) if (votes[index] > votes[best]) best = index;
  return best;
}
