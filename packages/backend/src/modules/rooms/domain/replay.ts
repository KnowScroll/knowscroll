/**
 * The replay of a finished Launch (R3 F, D-241): the rules of when one can be played again and what it may say of the people who
 * played it. Pure: the clock and the rows are arguments. A replay stores nothing about the person playing it, so nothing here decides
 * what is kept: the answers it reads are the Launch's own, kept seven days from the end of its play time and then deleted (D-220).
 */
import { PLAY_MS, RESULTS_KEPT_DAYS } from './launch.js';

/**
 * The start times between which a Launch can be replayed at `now`: its play time has ended (`startedBefore`) and its answers are still
 * kept (`startedAfter`, the same seven days the purge counts from the end). The two bounds are both inclusive.
 */
export function replayWindow(now: Date): { readonly startedBefore: Date; readonly startedAfter: Date } {
  return {
    startedBefore: new Date(now.getTime() - PLAY_MS),
    startedAfter: new Date(now.getTime() - PLAY_MS - RESULTS_KEPT_DAYS * 86_400_000),
  };
}

/**
 * One person's answer to one question, as a replay reads it: who, which question and whether it was right. Never which option was
 * picked and never how long it took: a replay may not say when anyone answered or who was quicker (D-241).
 */
export interface RecordedAnswer {
  readonly accountId: string;
  readonly round: number;
  readonly correct: boolean;
}

/** The answers a reader may see: those of people they have not blocked (a block is the reader's choice, D-051). */
export const visibleTo = (answers: readonly RecordedAnswer[], hidden: ReadonlySet<string>): readonly RecordedAnswer[] =>
  answers.filter((answer) => !hidden.has(answer.accountId));

/** How many people answered at least one question. A person who only joined did not play. */
export const playedBy = (answers: readonly RecordedAnswer[]): number =>
  new Set(answers.map((answer) => answer.accountId)).size;

/**
 * Whether the reader is offered this Launch's replay: somebody they have not blocked answered, and the reader was not one of the
 * people who answered. A person who played has seen the questions and their own answer is among the recorded ones, so they would be
 * played against themselves.
 */
export const replayOffered = (
  answers: readonly RecordedAnswer[],
  hidden: ReadonlySet<string>,
  readerId: string,
): boolean => !answers.some((answer) => answer.accountId === readerId) && visibleTo(answers, hidden).length > 0;

/** What one question's recorded answers say: how many answered, how many were right and who. */
export interface RoundFigures {
  readonly locked: number;
  readonly right: number;
  /** The accounts that got it right, in account order: an order that says nothing about who answered first. */
  readonly calledIt: readonly string[];
}

/** The figures of one round from the answers already limited to what the reader may see. No time enters them. */
export function roundFigures(answers: readonly RecordedAnswer[], round: number): RoundFigures {
  const ofRound = answers.filter((answer) => answer.round === round);
  const right = ofRound.filter((answer) => answer.correct).map((answer) => answer.accountId);
  return { locked: ofRound.length, right: right.length, calledIt: right.toSorted() };
}
