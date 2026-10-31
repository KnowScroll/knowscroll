import type { ScenarioCard } from '@knowscroll/contracts';

/**
 * What a what-if branch's short answer shows (D-211): the card's own label, how it waits, how long it took and when a
 * thread has made all it may today. Pure: the server owns the answer and the cap; this only says them in words.
 */

/** What every short answer is labelled, in the card and for a screen reader (T3: "What-if · made by KnowScroll"). */
export const WHAT_IF_MADE_BY = 'What-if · made by KnowScroll';

/** About how long a short answer takes, in the words the card says while it waits. */
export const ANSWER_WAIT_WORDS = 'about 30 s';

/** After this long the card says it is taking longer than usual instead of repeating "about 30 s". */
const SLOW_AFTER_MS = 90_000;

/** The most branches one thread may make in a UTC day (D-076): what-ifs and perspectives together. */
export const THREAD_DAILY_BRANCH_CAP = 5;

/**
 * The one state a what-if's card is in, for the screen to choose its body by:
 * `none` carries no short answer (a perspective, or a branch made before they existed);
 * `making` is the honest wait; `slow` is a wait that has gone past the usual;
 * `ready` is an answer that passed the card's checks; `unavailable` is a branch the short answer will not come for.
 */
export type AnswerStage = 'none' | 'making' | 'slow' | 'ready' | 'unavailable';

export function answerStage(card: Pick<ScenarioCard, 'answer' | 'createdAt' | 'status'>, now: Date): AnswerStage {
  if (card.status === 'removed' || card.answer === undefined) return 'none';
  if (card.answer.status === 'making')
    return now.getTime() - new Date(card.createdAt).getTime() >= SLOW_AFTER_MS ? 'slow' : 'making';
  return card.answer.status;
}

/** Whether the board should be read again soon: a branch is being prepared, or its short answer is being written. */
export const awaitingServer = (cards: readonly Pick<ScenarioCard, 'status' | 'answer'>[]): boolean =>
  cards.some((card) => card.status === 'preparing' || card.answer?.status === 'making');

/**
 * A key that changes when a card of the thread grows because its short answer arrived, so a reader who is at the end
 * of the conversation is kept there instead of finding the new answer below the fold.
 */
export const answersKey = (cards: readonly Pick<ScenarioCard, 'answer'>[]): string =>
  String(cards.filter((card) => card.answer !== undefined && card.answer.status !== 'making').length);

/** How many seconds a ready answer took, from the branch being chosen to the answer being ready; never negative. */
export function madeInSeconds(card: Pick<ScenarioCard, 'answer' | 'createdAt'>): number | undefined {
  if (card.answer?.status !== 'ready') return undefined;
  return Math.max(0, Math.round((new Date(card.answer.readyAt).getTime() - new Date(card.createdAt).getTime()) / 1000));
}

/**
 * How many branches this thread made since the start of the UTC day, removed ones included: the server counts every
 * order it commissioned, and a removed branch is still a card here, so the two agree.
 */
export function branchesMadeToday(cards: readonly Pick<ScenarioCard, 'createdAt'>[], now: Date): number {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return cards.filter((card) => new Date(card.createdAt).getTime() >= startOfDay).length;
}

/** Whether the thread has made all the branches it may today. The server decides; this only explains a refusal. */
export const threadMadeAllToday = (cards: readonly Pick<ScenarioCard, 'createdAt'>[], now: Date): boolean =>
  branchesMadeToday(cards, now) >= THREAD_DAILY_BRANCH_CAP;

/** The card's accessible name: the label, the idea and what state it is in, in words. */
export function answerLabel(card: Pick<ScenarioCard, 'title' | 'answer' | 'status'>): string {
  const state =
    card.answer?.status === 'ready' ? 'ready' : card.answer?.status === 'making' ? 'being made' : 'no short answer';
  return `${WHAT_IF_MADE_BY}: ${card.title}, ${state}`;
}
