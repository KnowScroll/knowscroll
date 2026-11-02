import type { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import type { AdmissionIssue } from '../application/ports.js';
import { MIN_SERVED_SENTENCES } from '../domain/ask-support.js';
import { placedSentencesOfAnswer } from './ask-support.js';

/**
 * The shape of the answer to a person's question (D-305): 8 to 12 sentences of reading text, and every sentence after the first
 * of its block stands on its own. Pure; the writer's validator applies it to the draft and the production job to the answer it serves.
 * "Reading text" is every sentence that is not a title, a heading or a callout's title, the dek included.
 */

/** The fewest and the most sentences of reading text in the writer's draft. */
export const ASK_ANSWER_MIN_SENTENCES = 8;
export const ASK_ANSWER_MAX_SENTENCES = 12;

/** The finding for an answer of the wrong length, and the finding for a sentence that leans on the one before. Each has a fixed repair hint. */
export const ANSWER_LENGTH_CODE = 'answer_sentences_out_of_brief';
export const LEANING_SENTENCE_CODE = 'sentence_leans_on_previous';

/**
 * Which length the answer must have. `draft`: the writer's own answer, 8 to 12 sentences. `after_check`: the revision a support
 * check earned and the answer served without its flagged sentences, which have lost some on purpose, so the floor is the fewest
 * an answer may be served with (D-307) and the ceiling is the same.
 */
export type AnswerStage = 'draft' | 'after_check';

/** The words that begin a sentence leaning on the one before: a pointer that needs the previous sentence to mean anything. */
const LEANING_OPENING = /^[\s"'“‘(\[]*(?:this|that|these|those|it|they)(?![\p{L}\p{N}])/iu;

/** Whether a sentence begins with a pointer ("This", "That", "It", "These", "Those", "They") that leans on the sentence before it. */
export const leansOnPrevious = (sentence: string): boolean => LEANING_OPENING.test(sentence);

/** The shape findings of an answer, located at `$` (the length) or at the block that holds a leaning sentence. */
export function answerShapeIssues(answer: AuthoredScroll, stage: AnswerStage): AdmissionIssue[] {
  const sentences = placedSentencesOfAnswer(answer);
  const reading = sentences.filter((sentence) => sentence.label !== true).length;
  const floor = stage === 'draft' ? ASK_ANSWER_MIN_SENTENCES : MIN_SERVED_SENTENCES;
  const issues: AdmissionIssue[] = [];
  if (reading < floor || reading > ASK_ANSWER_MAX_SENTENCES) issues.push({ code: ANSWER_LENGTH_CODE, path: '$' });

  const opened = new Set<number>();
  const leaning = new Set<number>();
  for (const sentence of sentences) {
    const { place } = sentence;
    if (!('block' in place) || sentence.label === true) continue;
    // The first sentence of a block opens it, so it has no sentence before it to lean on.
    if (!opened.has(place.block)) opened.add(place.block);
    else if (leansOnPrevious(sentence.text)) leaning.add(place.block);
  }
  for (const block of [...leaning].sort((first, second) => first - second))
    issues.push({ code: LEANING_SENTENCE_CODE, path: `blocks.${String(block)}` });
  return issues;
}
