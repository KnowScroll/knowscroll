/**
 * The residents' feed (v3 R-8, D-248): when a resident may post a find about a library asset, which asset it is, and what its
 * note may say. Pure: facts in, a decision out, with no database, clock, model or network. Code chooses the asset and decides
 * whether anyone posts; the model only writes a short note, which code checks again before it is stored.
 */
import { textProblem, type ContributionProblem, type InhabitantId } from './contribution.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What residents post on their own, and when they look. Shown to members from these numbers, so a screen cannot say another. */
export const FEED_RULES = {
  /** The most finds a room gets on one UTC day, whichever residents post them. */
  postsPerDay: 3,
  /** The rest between two finds of the same resident in the same room. */
  residentRestMs: 6 * HOUR,
  /** The heartbeat: residents look at a room three times a day, one look per slot. */
  slotMs: 8 * HOUR,
  /** The longest note, in characters: one or two sentences. */
  noteMaxChars: 280,
  /** A discussion's title is at most this long. */
  titleMaxChars: 80,
  /** A queued turn this old is taken to be lost: its job ended without settling it. It stays counted. */
  lapsesAfterMs: HOUR,
  /** The most assets one look reads before it chooses. */
  candidatesRead: 40,
} as const;

/** A library asset a resident may post about: an admitted Reel or Scroll of the room's topic. */
export interface FindCandidate {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly kind: 'reel' | 'scroll';
  readonly title: string;
  readonly summary: string;
}

/**
 * The asset a resident posts about: the first of `candidates` (which arrive newest first) that the room has not seen. Newer
 * library material surfaces first, and nothing is offered twice. `undefined` when the library has nothing new for the room, in
 * which case nobody posts and nothing is asked of a model.
 */
export function pickFind(candidates: readonly FindCandidate[], seen: ReadonlySet<string>): FindCandidate | undefined {
  return candidates.find((candidate) => !seen.has(candidate.assetId));
}

/** The start of the 8-hour UTC slot containing `now`, as an ISO time: the heartbeat that is looking. */
export function slotOf(now: Date): string {
  const start = Math.floor(now.getTime() / FEED_RULES.slotMs) * FEED_RULES.slotMs;
  return new Date(start).toISOString();
}

/** The start of the UTC day containing `now`. */
export const dayStartOf = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** What counted turns the room has taken lately, over every kind of unprompted turn and over finds alone. */
export interface FeedCounts {
  readonly roomLastHour: number;
  readonly roomToday: number;
  /** Finds the room has had since the UTC day began. */
  readonly feedToday: number;
}

export interface FeedFacts {
  readonly now: Date;
  readonly room: {
    readonly open: boolean;
    /** The room's residents in the order they are shown. */
    readonly cast: readonly InhabitantId[];
    /** Current members whose AI level is not Off. */
    readonly listeners: number;
  };
  /** The asset code picked, or none when the room has seen everything the library holds for its topic. */
  readonly candidate: FindCandidate | undefined;
  /** When each resident last had a find counted in this room. */
  readonly lastFindAt: Readonly<Partial<Record<InhabitantId, Date>>>;
  readonly counts: FeedCounts;
}

/** The cap that refused a find. */
export type FeedCap = 'room_hour' | 'room_day' | 'feed_day';

/** Why a look ended with nothing to record: there was nothing to decide, or nobody may post now. */
export type FeedDrop = 'room_closed' | 'no_resident' | 'nobody_listening' | 'nothing_new' | 'resting';

export type FeedDecision =
  | { readonly kind: 'drop'; readonly reason: FeedDrop }
  /** A cap said no. Recorded as a quiet row: it posts nothing, shows nothing and calls no model. */
  | { readonly kind: 'refuse'; readonly cap: FeedCap; readonly inhabitant: InhabitantId; readonly counts: FeedCounts }
  | { readonly kind: 'post'; readonly inhabitant: InhabitantId; readonly counts: FeedCounts };

/**
 * The resident whose turn it is: one whose rest is over, the one who posted longest ago first, and the cast's order breaking a
 * tie. None when every resident is still resting.
 */
export function residentToPost(
  cast: readonly InhabitantId[],
  lastFindAt: FeedFacts['lastFindAt'],
  now: Date,
): InhabitantId | undefined {
  const rested = cast.filter((inhabitant) => {
    const last = lastFindAt[inhabitant];
    return last === undefined || now.getTime() - last.getTime() >= FEED_RULES.residentRestMs;
  });
  return rested.reduce<InhabitantId | undefined>((best, inhabitant) => {
    if (best === undefined) return inhabitant;
    const bestLast = lastFindAt[best]?.getTime() ?? -Infinity;
    const last = lastFindAt[inhabitant]?.getTime() ?? -Infinity;
    return last < bestLast ? inhabitant : best;
  }, undefined);
}

/** The first cap a find would break, if any. A find is not a reply, so the ratio to people's messages does not apply. */
function capBroken(counts: FeedCounts, perHour: number, perDay: number): FeedCap | undefined {
  if (counts.feedToday >= FEED_RULES.postsPerDay) return 'feed_day';
  if (counts.roomLastHour >= perHour) return 'room_hour';
  if (counts.roomToday >= perDay) return 'room_day';
  return undefined;
}

/**
 * Decides one look at one room. The order is the policy: a room that is closed, has no resident or has nobody listening is let
 * go first; then no new asset (the library is finite, so a feed runs dry honestly instead of repeating itself); then every
 * resident resting; only then the caps, which are the room's own unprompted caps (`roomPerHour`, `roomPerDay`, shared with the
 * router) and the feed's three a day. A refusal is recorded and quiet. Zero model calls come from every branch but `post`.
 */
export function routeFeed(
  facts: FeedFacts,
  caps: { readonly roomPerHour: number; readonly roomPerDay: number },
): FeedDecision {
  const { room, counts } = facts;
  if (!room.open) return { kind: 'drop', reason: 'room_closed' };
  if (room.cast.length === 0) return { kind: 'drop', reason: 'no_resident' };
  if (room.listeners === 0) return { kind: 'drop', reason: 'nobody_listening' };
  if (facts.candidate === undefined) return { kind: 'drop', reason: 'nothing_new' };
  const inhabitant = residentToPost(room.cast, facts.lastFindAt, facts.now);
  if (inhabitant === undefined) return { kind: 'drop', reason: 'resting' };
  const cap = capBroken(counts, caps.roomPerHour, caps.roomPerDay);
  return cap === undefined ? { kind: 'post', inhabitant, counts } : { kind: 'refuse', cap, inhabitant, counts };
}

/** A discussion's title for a find: the asset's own title, cut to fit with an ellipsis. */
export function findTitle(title: string): string {
  const clean = title.replaceAll(/\s+/gu, ' ').trim();
  const characters = [...clean];
  return characters.length <= FEED_RULES.titleMaxChars
    ? clean
    : `${characters
        .slice(0, FEED_RULES.titleMaxChars - 1)
        .join('')
        .trimEnd()}…`;
}

// --- The voice of a note -------------------------------------------------------------------

export type VoiceProblem = 'first_person' | 'claims_experience';
export type NoteProblem = ContributionProblem | VoiceProblem;

/**
 * A resident has not watched, read or lived anything. "I", "me" and "my" are claims of a self that is not there, so a note
 * has none of them; a Roman numeral that follows a word that takes one ("Type I supernova") is not the pronoun.
 */
const ROMAN_NUMERAL_I =
  /\b(?:type|phase|stage|class|group|category|part|chapter|level|grade|volume|act|section|mark|world war|war)\s+I\b/giu;
/** Only the capital "I" is the pronoun; "i" in lower case is a letter or a variable, and "me" and "my" have their own pattern. */
const CAPITAL_I = /\bI(?:['’](?:m|ve|d|ll))?\b/u;
const OTHER_FIRST_PERSON = /\b(?:me|my|mine|myself)\b/iu;

/** Phrases that claim an experience, a memory or a feeling about the asset, whoever the pronoun is. */
const EXPERIENCE_CLAIMS: readonly RegExp[] = [
  /\b(?:changed|changes|changing|shifted|shifts|reshaped|reshapes|rewired|rewires)\s+(?:how|the way)\b/iu,
  /\b(?:remember|remembered|recall|recalled)\b/iu,
  /\b(?:we|you(?:['’]ve| have))\s+(?:all\s+)?(?:watched|seen|read|heard|learned|learnt|binged|rewatched)\b/iu,
  /\bwe\s+(?:loved|found|discovered|stumbled)\b/iu,
  /\b(?:binge-?watch(?:ed|ing)?|rewatch(?:ed|ing)?|re-?read(?:ing)?)\b/iu,
  /\b(?:blew|blows|blown)\s+(?:my|our|your)\s+mind\b/iu,
  /\b(?:growing up|as a (?:kid|child)|years ago|back in the day|when we were)\b/iu,
  /\b(?:has|have)\s+a lot to answer for\b/iu,
  /\b(?:stayed|stuck|stays|sticks)\s+with\s+(?:me|us)\b/iu,
];

/**
 * Whether the words speak in a self that is not there: no first person, and none of the phrases that claim experience
 * ("changed how I picture…", "I remember when…"). One guard for a find's note and for the room's memory: a resident has
 * watched, read and lived nothing. It does not judge quality.
 */
export function voiceProblem(text: string): VoiceProblem | undefined {
  const spoken = text.replaceAll(ROMAN_NUMERAL_I, '');
  if (CAPITAL_I.test(spoken) || OTHER_FIRST_PERSON.test(spoken)) return 'first_person';
  if (EXPERIENCE_CLAIMS.some((claim) => claim.test(text))) return 'claims_experience';
  return undefined;
}

/**
 * What is wrong with a find's note, if anything: the contribution rules (empty, too long, a link, a claim to be a person) at
 * the note's length, then the voice guard. A model that fails it gets one fixed hint to revise and, failing again, nothing is
 * posted.
 */
export function noteProblem(text: string): NoteProblem | undefined {
  return textProblem(text, FEED_RULES.noteMaxChars) ?? voiceProblem(text);
}

/**
 * The replies under one post that were written by the same signer in the same voice. `signer` is the member who wrote them, or the
 * member whose scout did; a resident's reply has none. `ownVoice` is a reply nobody asked for (a resident speaking on its own, or a
 * scout): the one an AI level of Off keeps from a reader. A resident's answer to a question someone asked is not.
 */
export interface ReplyGroup {
  readonly signer: string | null;
  readonly ownVoice: boolean;
  readonly count: number;
}

/**
 * How many replies a reader's thread shows under a post (D-299): a reply from someone the reader blocked is a collapsed marker and a
 * reply an Off reader is told nothing of is a muted one, so neither counts for them. A moderator's removal is not a reply at all.
 */
export function repliesShownTo(
  groups: readonly ReplyGroup[],
  reader: { readonly aiOff: boolean; readonly blocked: ReadonlySet<string> },
): number {
  return groups
    .filter((group) => !(group.signer !== null && reader.blocked.has(group.signer)))
    .filter((group) => !(group.ownVoice && reader.aiOff))
    .reduce((total, group) => total + group.count, 0);
}
