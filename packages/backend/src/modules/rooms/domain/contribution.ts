/** Rules of the labelled AI inhabitants: what they may say, and how often a room may ask them. */

export type InhabitantId = 'explainer' | 'skeptic';
export type ContributionKind = 'explanation' | 'assumption' | 'perspective' | 'counterexample';

/** What each inhabitant is allowed to contribute. The Explainer answers; the Skeptic challenges. */
export const KINDS_OF: Readonly<Record<InhabitantId, readonly ContributionKind[]>> = {
  explainer: ['explanation'],
  skeptic: ['assumption', 'perspective', 'counterexample'],
};

/** The longest contribution, in characters: a suggestion in a few sentences, never an essay. */
export const CONTRIBUTION_MAX_CHARS = 600;
/** How many contributions one room may ask for in a UTC day, whoever asks (D-068: replaces D-051's 12). */
export const ROOM_ASKS_PER_DAY = 80;
/** How many one person may ask for in an hour, across rooms (D-068: replaces D-051's 4 a day). */
export const PERSON_ASKS_PER_HOUR = 10;
/**
 * How many asks of any outcome one person may make in an hour, across rooms: also those that failed
 * before reaching the provider. The bound above never counts those, so this one keeps them from piling up.
 */
export const PERSON_REQUESTS_PER_HOUR = 20;
/** An ask still queued after this long no longer holds its discussion (the job was lost or erased). */
export const QUEUED_ASK_LAPSES_MS = 15 * 60 * 1000;
/** The newest messages of a discussion an inhabitant reads, and the most characters of each. */
export const CONTEXT_MESSAGES = 20;
export const CONTEXT_MESSAGE_CHARS = 600;

export interface AskFacts {
  /**
   * Asks counted against this room since the UTC day began: queued, answered or declined ones, and
   * failed ones that reached the provider. Only an ask that never reached the provider is not counted.
   */
  readonly roomAsksToday: number;
  /** The same, for the person across rooms, over the last hour. */
  readonly personAsksLastHour: number;
  /** Every ask of the person over the last hour, whatever became of it. */
  readonly personRequestsLastHour: number;
  /** An ask of this discussion is still being prepared. */
  readonly openAsk: boolean;
}

export type AskDecision = 'allowed' | 'preparing' | 'room_resting' | 'person_resting';

/**
 * Whether a member may ask an inhabitant now. One turn is prepared per discussion at a time, and a
 * room has a daily bound and a person an hourly one, so asks can never fill a room. Asked turns have
 * their own bounds apart from the unprompted caps (`router.ts`).
 */
export function askDecision(facts: AskFacts): AskDecision {
  if (facts.openAsk) return 'preparing';
  if (facts.roomAsksToday >= ROOM_ASKS_PER_DAY) return 'room_resting';
  if (facts.personAsksLastHour >= PERSON_ASKS_PER_HOUR || facts.personRequestsLastHour >= PERSON_REQUESTS_PER_HOUR)
    return 'person_resting';
  return 'allowed';
}

/** The start of the UTC day containing `now`: the bound counts asks from here. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The start of the hour that ended at `now`: the person's bound counts asks from here. */
export function hourBefore(now: Date): Date {
  return new Date(now.getTime() - 60 * 60 * 1000);
}

export type ContributionProblem = 'empty' | 'too_long' | 'has_link' | 'claims_to_be_a_person';

const LINK = /https?:\/\/|www\./i;
const PERSON_CLAIM =
  /\b(?:i am|i'm|as)\s+(?:a\s+|an\s+)?(?:human|real person|person|student|engineer|teacher|developer)\b/i;

/**
 * What is wrong with an inhabitant's words, if anything. An inhabitant never pretends to be a person
 * and never sends people away to a link; a model that does is refused and gets one fixed hint to
 * revise. This is a guard against the two failures that matter, not a judgement of quality.
 */
export function contributionProblem(text: string): ContributionProblem | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if ([...trimmed].length > CONTRIBUTION_MAX_CHARS) return 'too_long';
  if (LINK.test(trimmed)) return 'has_link';
  if (PERSON_CLAIM.test(trimmed)) return 'claims_to_be_a_person';
  return undefined;
}
