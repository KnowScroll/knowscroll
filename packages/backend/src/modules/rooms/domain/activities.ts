/**
 * Optional room activity (R03): a moderator's poll or quiz. Pure rules: the stored shape with
 * server-assigned IDs, and who may do what while it is open. No database, clock or crypto.
 */
import type { RoomStatus } from './membership.js';

/** Open at once in one room, so a room never becomes a stack of questions. */
export const MAX_OPEN_ACTIVITIES = 5;
/** Started in one room in a UTC day. */
export const MAX_STARTED_PER_DAY = 20;
/** The voters a poll option names; the vote count is exact beyond it. */
export const VOTERS_SHOWN = 12;
/** The activities one list answers with. */
export const MAX_LISTED = 30;

export type ActivityKind = 'poll' | 'quiz';
export type ActivityState = 'open' | 'closed' | 'removed';

export interface StoredOption {
  readonly id: string;
  readonly text: string;
}
export interface StoredExplanation {
  readonly heading: string;
  readonly text: string;
  readonly note?: string;
}
export type StoredDefinition =
  | { readonly kind: 'poll'; readonly prompt: string; readonly options: readonly StoredOption[] }
  | {
      readonly kind: 'quiz';
      readonly title: string;
      readonly questions: readonly {
        readonly id: string;
        readonly prompt: string;
        readonly options: readonly StoredOption[];
        readonly explanation: StoredExplanation;
      }[];
    };

export type NewActivityInput =
  | { readonly kind: 'poll'; readonly prompt: string; readonly options: readonly string[] }
  | {
      readonly kind: 'quiz';
      readonly title: string;
      readonly questions: readonly {
        readonly prompt: string;
        readonly options: readonly string[];
        readonly explanation: StoredExplanation;
      }[];
    };

const optionsOf = (texts: readonly string[]): StoredOption[] =>
  texts.map((text, index) => ({ id: `o${String(index + 1)}`, text }));

/** The stored shape of a new activity: options get o1.., questions q1.., in the order given. */
export function definitionOf(input: NewActivityInput): StoredDefinition {
  if (input.kind === 'poll') return { kind: 'poll', prompt: input.prompt, options: optionsOf(input.options) };
  return {
    kind: 'quiz',
    title: input.title,
    questions: input.questions.map((question, index) => ({
      id: `q${String(index + 1)}`,
      prompt: question.prompt,
      options: optionsOf(question.options),
      explanation: question.explanation,
    })),
  };
}

/** What shows in a list: a poll's question, a quiz's title. */
export const titleOf = (definition: StoredDefinition): string =>
  definition.kind === 'poll' ? definition.prompt : definition.title;

/** A vote counts only while the poll is open and the room is taking part (not paused or closed). */
export const acceptsVotes = (roomStatus: RoomStatus, state: ActivityState): boolean =>
  roomStatus === 'open' && state === 'open';

/** A moderator starts a new activity only in a room that is open. */
export const acceptsNewActivity = (roomStatus: RoomStatus): boolean => roomStatus === 'open';
