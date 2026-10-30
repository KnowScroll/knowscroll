/**
 * "While you were away" (R3 C, T3 question 15, D-169): when a returning member is owed a summary, which window it
 * belongs to and what it covers, and the welcome a newcomer reads. Pure rules; no database, clock or model.
 */
import type { AiLevel } from './membership.js';

const HOUR_MS = 3_600_000;

/** Away at least this long before a return counts (R3's behaviour table: 12 hours). */
export const AWAY_AFTER_MS = 12 * HOUR_MS;
/** And at least this many new messages by other people or residents were shown meanwhile (R3: 15). */
export const AWAY_MIN_NEW_MESSAGES = 15;
/** A window is a 12-hour UTC block of a room: one summary per room and window, however many members return in it. */
export const WINDOW_MS = 12 * HOUR_MS;
/** A summary never covers further back than this, so it stays a recap of the last day, not of a week. */
export const COVERS_AT_MOST_MS = 24 * HOUR_MS;
/** The newest messages a summary reads, and the most characters of each (the context stays small and fixed). */
export const SUMMARY_MESSAGES = 60;
/** A member's card is shown for this long after the summary was written: a catch-up is for the return, not for next week. */
export const CARD_LIFE_MS = 24 * HOUR_MS;

/** The 12-hour UTC block containing `at`, numbered from the epoch. It is the key of "one call per window per room". */
export const windowOf = (at: Date): number => Math.floor(at.getTime() / WINDOW_MS);

export interface ReturnFacts {
  /** The last time this member's device said the room was open; none for a member who has never opened it. */
  readonly previous: Date | undefined;
  readonly now: Date;
  /** Messages shown since `previous` that this member did not write. */
  readonly newMessages: number;
  /** Their own level: a member who has AI Off is owed nothing and costs nothing. */
  readonly level: AiLevel;
}

/**
 * Whether a return could start a "while you were away": the member listens and was away long enough. It needs no
 * message count, so a caller checks it first and reads the count (a query) only for a return that passes.
 */
export function wasAwayLongEnough(facts: Pick<ReturnFacts, 'previous' | 'now' | 'level'>): boolean {
  if (facts.previous === undefined || facts.level === 'off') return false;
  return facts.now.getTime() - facts.previous.getTime() >= AWAY_AFTER_MS;
}

/** Whether a return starts a "while you were away": long enough away, enough said meanwhile, and the member listens. */
export function isOwedSummary(facts: ReturnFacts): boolean {
  return wasAwayLongEnough(facts) && facts.newMessages >= AWAY_MIN_NEW_MESSAGES;
}

/** Where a window's summary starts: when the first member to return left, but never more than a day before it is written. */
export function coversFrom(previous: Date, now: Date): Date {
  return new Date(Math.max(previous.getTime(), now.getTime() - COVERS_AT_MOST_MS));
}

/**
 * The welcome a member reads before they have read the AI notice (R3: "one welcome line, a template, 0 calls"). It
 * is filled from the room's own name and the meaning of its topic, so it says only what the room is. The words are
 * the resident's own and carry no claim to have seen, read or remembered anything.
 */
export function welcomeText(room: { readonly name: string; readonly topicMeaning: string | undefined }): string {
  const meaning = room.topicMeaning?.trim();
  const about = meaning === undefined || meaning === '' ? '' : ` ${/[.!?]$/u.test(meaning) ? meaning : `${meaning}.`}`;
  return `Welcome to ${room.name}.${about} Ask me anything here, or just say hello in General.`;
}
