import type { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import type { AdmissionIssue } from '../application/ports.js';
import { MIN_SERVED_SENTENCES } from '../domain/ask-support.js';
import { placedSentencesOfAnswer } from './ask-support.js';

/**
 * The shape of the answer to a person's question (D-308, D-309, D-350). Pure; the writer's validator applies the length to the draft
 * after code has taken out what it can (`ask-answer-trim.ts`), and the production job to the answer it serves.
 * "Reading text" is every sentence that is not a title, a heading or a callout's title, the dek included.
 */

/** The length the writer is asked for: 8 to 12 sentences of reading text. It is an instruction, not what code refuses. */
export const ASK_ANSWER_MIN_SENTENCES = 8;
export const ASK_ANSWER_MAX_SENTENCES = 12;

/**
 * What code refuses (D-350): an answer of fewer sentences than the fewest a trimmed answer may be served with
 * ({@link MIN_SERVED_SENTENCES}) or of more than {@link ASK_ANSWER_CEILING_SENTENCES}. The writer's range is asked for; this
 * is the wider range that a draft and a revision are both held to, since code takes sentences out of either.
 */
export const ASK_ANSWER_FLOOR_SENTENCES = MIN_SERVED_SENTENCES;
export const ASK_ANSWER_CEILING_SENTENCES = 20;

/**
 * The dek given to an answer whose own dek cannot be served (D-351). It states no fact; the stored document needs a dek of ten
 * characters or more. It is code's line, so it never counts among the sentences of an answer (D-356).
 */
export const NEUTRAL_DEK = 'A short answer to your question.';

/** The finding for an answer outside the range code holds, and the finding for an opening paragraph that code took out whole. Each has a fixed repair hint. */
export const ANSWER_LENGTH_CODE = 'answer_sentences_out_of_brief';
export const DIRECT_ANSWER_LOST_CODE = 'direct_answer_lost';

/**
 * The fixed repair hint for an answer outside the range code holds. It names the range the writer is asked for and never holds the
 * writer's words.
 */
export function answerLengthHint(): string {
  return `The answer must have ${String(ASK_ANSWER_MIN_SENTENCES)} to ${String(ASK_ANSWER_MAX_SENTENCES)} sentences of reader text (a title, a heading and a callout title do not count): the direct answer, at most two short sections and the closing callout.`;
}

/** The fixed repair hint for an opening paragraph whose every sentence repeated the passages, so none could be kept. */
export const DIRECT_ANSWER_LOST_HINT =
  'The opening paragraph must answer the question in at least one sentence of your own words; every sentence of it repeated the passages too closely and was taken out.';

/** The words that begin a sentence leaning on the one before: a pointer that needs the previous sentence to mean anything. */
const LEANING_OPENING = /^[\s"'“‘([]*(?:this|that|these|those|it|they)(?![\p{L}\p{N}])/iu;

/** Whether a sentence begins with a pointer ("This", "That", "It", "These", "Those", "They") that leans on the sentence before it. */
export const leansOnPrevious = (sentence: string): boolean => LEANING_OPENING.test(sentence);

/**
 * The number of sentences of reading text in an answer: every sentence that is not a title, a heading or a callout's title, and not the
 * dek when it is the line code wrote ({@link NEUTRAL_DEK}), which is no sentence of the answer's own (D-356).
 */
export const readingSentencesOf = (answer: AuthoredScroll): number =>
  placedSentencesOfAnswer(answer).filter(
    (sentence) => sentence.label !== true && !(sentence.place.field === 'dek' && hasCodeMadeDek(answer)),
  ).length;

/** Whether the dek of an answer is the line code wrote, whole. */
export const hasCodeMadeDek = (answer: Pick<AuthoredScroll, 'dek'>): boolean => answer.dek === NEUTRAL_DEK;

/** The length finding of an answer, located at `$`: none while it has {@link ASK_ANSWER_FLOOR_SENTENCES} to {@link ASK_ANSWER_CEILING_SENTENCES} sentences of reading text. */
export function answerShapeIssues(answer: AuthoredScroll): AdmissionIssue[] {
  const reading = readingSentencesOf(answer);
  return reading < ASK_ANSWER_FLOOR_SENTENCES || reading > ASK_ANSWER_CEILING_SENTENCES
    ? [{ code: ANSWER_LENGTH_CODE, path: '$' }]
    : [];
}
