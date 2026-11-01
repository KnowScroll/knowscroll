/**
 * The room's sky: what earns a star, when one is refused, how stars become a constellation and how a constellation is
 * named (D-174, D-175). Pure: no database, clock or crypto beyond the arguments. Stars are room-level facts that name no
 * person; a person's own acts only decide whether a star is earned.
 */

/** Stars in a constellation. The contract names the same number (`ROOM_STARS_PER_CONSTELLATION`); the contract's schema refuses any other number, so a disagreement fails every read. */
export const STARS_PER_CONSTELLATION = 7;

/** How long the name vote of a finished constellation stays open, in hours (the contract's `ROOM_NAMING_HOURS`). */
export const NAMING_HOURS = 24;

/** What earns a star (the contract's `RoomStarAct`). */
export type StarAct = 'answer_useful' | 'debate_closed' | 'daily_solved' | 'launch_finished';

/** The sky as a station draws it; the contract's `RoomSky` has the same shape. */
export interface Sky {
  readonly lit: number;
  readonly of: typeof STARS_PER_CONSTELLATION;
  readonly state: 'forming' | 'naming' | 'named';
  readonly finished: number;
  readonly constellationName?: string;
}

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
    readonly kind: 'general' | 'topic' | 'today' | 'find' | 'intro';
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
 * answered), nor does a mark on one's own message, a card, General chat, a debate or a find (a resident's post about a library asset).
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
  Math.floor(starsBefore / STARS_PER_CONSTELLATION) + 1;

/** Whether the star just earned (the room now has `starsNow`) finished a constellation. */
export const finishesConstellation = (starsNow: number): boolean =>
  starsNow > 0 && starsNow % STARS_PER_CONSTELLATION === 0;

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
}): Sky {
  const finished = Math.floor(input.stars / STARS_PER_CONSTELLATION);
  const lit = input.stars === 0 ? 0 : ((input.stars - 1) % STARS_PER_CONSTELLATION) + 1;
  const full = lit === STARS_PER_CONSTELLATION;
  return {
    lit,
    of: STARS_PER_CONSTELLATION,
    state: !full ? 'forming' : input.latestIsNamed ? 'named' : 'naming',
    finished,
    ...(input.latestName === undefined ? {} : { constellationName: input.latestName }),
  };
}

// --- Naming ---------------------------------------------------------------------------------

/** When a constellation's name vote closes, from when its seventh star landed. */
export const namingClosesAt = (completedAt: Date): Date => new Date(completedAt.getTime() + NAMING_HOURS * 3_600_000);

/**
 * Names a constellation may be offered under: short, plain, and shaped like the design's own ("The Press"). Lists are by
 * library system so a room's names fit its topic (eighteen each); a system without a list uses the shared one (twenty-four).
 * Chosen by code from fixed lists, never by a model, and never typed by a member. A room offers a name another of its
 * constellations holds or is offered only when the list has fewer than three left, so a repeat is rare and never a surprise.
 */
const NAMES: Readonly<Record<string, readonly string[]>> = {
  space: [
    'The Lantern',
    'The Long Way',
    'The Kite',
    'The Quiet Sun',
    'The Ferry',
    'The Compass',
    'The Orbit',
    'The Comet',
    'The Telescope',
    'The Far Shore',
    'The Dark Road',
    'The Lighthouse',
    'The Night Watch',
    'The Slow Light',
    'The Anchor',
    'The Meridian',
    'The Drift',
    'The Beacon',
  ],
  earth: [
    'The Tilt',
    'The Tide',
    'The Long Year',
    'The Weather Vane',
    'The Ridge',
    'The Thaw',
    'The Equinox',
    'The Fault Line',
    'The Monsoon',
    'The Glacier',
    'The Delta',
    'The Seam',
    'The Rain Gauge',
    'The Canyon',
    'The Trade Wind',
    'The Horizon',
    'The Current',
    'The Summit',
  ],
  'human-body': [
    'The Heartbeat',
    'The Loom',
    'The Pulse',
    'The Spiral',
    'The Garden',
    'The Breath',
    'The Relay',
    'The Bridge',
    'The Rhythm',
    'The Root',
    'The Signal',
    'The Engine',
    'The Thread',
    'The Tide',
    'The Hinge',
    'The Weave',
    'The Spark',
    'The Hearth',
  ],
  'machine-learning': [
    'The Gradient',
    'The Loom',
    'The Relay',
    'The Net',
    'The Climb',
    'The Lantern',
    'The Weights',
    'The Layer Cake',
    'The Slow Learner',
    'The Hill',
    'The Echo',
    'The Lattice',
    'The Compass',
    'The Sieve',
    'The Long Run',
    'The Switchback',
    'The Window',
    'The Draft',
  ],
  computing: [
    'The Relay',
    'The Gate',
    'The Loom',
    'The Stack',
    'The Switch',
    'The Lantern',
    'The Queue',
    'The Loop',
    'The Bus',
    'The Clock',
    'The Pipeline',
    'The Ledger',
    'The Patch',
    'The Handshake',
    'The Cache',
    'The Fork',
    'The Lathe',
    'The Circuit',
  ],
  history: [
    'The Ledger',
    'The Long Road',
    'The Bridge',
    'The Archive',
    'The Ember',
    'The Lantern',
    'The Map Room',
    'The Chronicle',
    'The Crossing',
    'The Hearth',
    'The Quill',
    'The Harbour',
    'The Milestone',
    'The Almanac',
    'The Watchtower',
    'The Caravan',
    'The Seal',
    'The Torch',
  ],
};
const SHARED_NAMES: readonly string[] = [
  'The Lantern',
  'The Long Way',
  'The Kite',
  'The Loom',
  'The Bridge',
  'The Ember',
  'The Compass',
  'The Harbour',
  'The Relay',
  'The Spiral',
  'The Beacon',
  'The Anchor',
  'The Garden',
  'The Hearth',
  'The Ridge',
  'The Thread',
  'The Weave',
  'The Window',
  'The Orbit',
  'The Echo',
  'The Lighthouse',
  'The Crossing',
  'The Spark',
  'The Torch',
];

/** The names a room of this library topic may be offered, in their fixed order. */
export const constellationNamesOf = (topicId: string): readonly string[] => NAMES[topicId] ?? SHARED_NAMES;

/**
 * Three different names for constellation `no`, from the room's topic list. `used` are the names its named constellations
 * hold and `offered` the names its other constellations without a name are offered, so a name is not offered twice at once
 * and never one a constellation already holds, while the list has three left. Only when it has fewer does a repeat appear:
 * unused names first, then names only offered elsewhere, then names held. Starts at a place the room and the number choose.
 */
export function constellationCandidates(input: {
  readonly topicId: string;
  readonly roomId: string;
  readonly no: number;
  readonly used: readonly string[];
  readonly offered?: readonly string[];
}): readonly [string, string, string] {
  const list = constellationNamesOf(input.topicId);
  const offered = input.offered ?? [];
  const fresh = list.filter((name) => !input.used.includes(name) && !offered.includes(name));
  const seed = Number.parseInt(input.roomId.replaceAll('-', '').slice(-8), 16) + input.no * 7;
  if (fresh.length >= 3) {
    const start = seed % fresh.length;
    return [fresh[start]!, fresh[(start + 1) % fresh.length]!, fresh[(start + 2) % fresh.length]!];
  }
  const pool = [
    ...fresh,
    ...list.filter((name) => !input.used.includes(name) && offered.includes(name)),
    ...list.filter((name) => input.used.includes(name)),
  ];
  return [pool[0]!, pool[1]!, pool[2]!];
}

/**
 * The name a vote settles on: the candidate with the most votes, a tie going to the earlier one, and no votes at all to the
 * first. A name the room already gave an earlier constellation (`taken`) is passed over while a free one is left. When all
 * three are held (the list is used up) the plain vote decides and a repeat is allowed, as `constellationCandidates` already
 * assumes. A rule anyone can compute from the counts, so no one decides a name by being last to look.
 */
export function winningCandidate(
  votes: readonly [number, number, number],
  taken: readonly [boolean, boolean, boolean] = [false, false, false],
): 0 | 1 | 2 {
  const free = ([0, 1, 2] as const).filter((index) => !taken[index]);
  const open = free.length > 0 ? free : ([0, 1, 2] as const);
  let best: 0 | 1 | 2 = open[0];
  for (const index of open) if (votes[index] > votes[best]) best = index;
  return best;
}
