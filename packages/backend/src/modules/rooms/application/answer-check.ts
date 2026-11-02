import type { ReasoningContext, ReasoningRole } from '../../../reasoning/public.js';
import {
  UNSUPPORTED_HINTS,
  askSupportContext,
  askSupportRole,
  splitSentences,
  unstatedFigures,
  type SentenceUnderCheck,
  type SupportPassage,
  type UnsupportedVerdict,
} from '../../content/public.js';
import type { GroundPassage } from '../domain/answer-support.js';
import type { InhabitantAnswer } from './inhabitant-role.js';

/**
 * The pieces of a resident's support check (D-301, D-302): the sentences of an answer, the figure rule, the checker's roles and what a
 * rewrite is told. The checker is the shared one the answer to an ask order goes through (D-250); a room gives
 * it roles of its own, so its failure brake and its budget never touch an ask order's, and the unprompted one is `ambient`.
 */

/** The checker for a member's ask, run as the asker. */
export const ASKED_CHECK_ROLE_ID = 'rooms.inhabitant-support';
/** The checker for a resident speaking on its own: its spend stays within the ambient share, like the writer's. */
export const AMBIENT_CHECK_ROLE_ID = 'rooms.ambient-support';

export type CheckRole = ReturnType<typeof askSupportRole>;

/** Who the answer is for, which decides the checker's role and the budget class it runs under. */
export type AnswerOrigin = 'asked' | 'unprompted';

/** The checker's role over these sentences and passages. */
export function supportRole(
  origin: AnswerOrigin,
  sentences: readonly SentenceUnderCheck[],
  passages: readonly SupportPassage[],
): CheckRole {
  const base = askSupportRole(sentences, passages);
  return origin === 'asked'
    ? { ...base, id: ASKED_CHECK_ROLE_ID }
    : { ...base, id: AMBIENT_CHECK_ROLE_ID, budgetClass: 'ambient' };
}

/** What the checker is sent for a draft: the passages its sentences cite and the sentences. */
export function supportContext(
  turnId: string,
  draft: 1 | 2,
  sentences: readonly SentenceUnderCheck[],
  passages: readonly SupportPassage[],
): ReasoningContext {
  return {
    bundleRef: `rooms-answer-support:${turnId}:${String(draft)}`,
    items: askSupportContext(sentences, passages),
  };
}

/** The sentences of an answer in reading order, each resting on the passages the whole answer cites. */
export function sentencesOf(answer: Pick<InhabitantAnswer, 'text' | 'cites'>): readonly SentenceUnderCheck[] {
  return splitSentences(answer.text).map((text, index) => ({ number: index + 1, text, cites: answer.cites }));
}

/** A sentence a draft must not keep, and what the writer is told about it: fixed hints only, never the checker's words. */
export interface FlaggedSentence {
  readonly number: number;
  readonly hints: readonly string[];
}

/** The hint for a figure no cited passage writes the way the sentence does. */
export const FIGURE_HINT =
  "A number, in digits or in words, may appear only where a passage you cite writes that same number the same way. Use the passage's own figure, or say it without a number.";

/** The sentences whose figures a cited passage does not state (D-208, D-302). Pure; no model. */
export function figureFlags(
  sentences: readonly SentenceUnderCheck[],
  passages: readonly SupportPassage[],
): readonly FlaggedSentence[] {
  const textOf = new Map(passages.map((passage) => [passage.handle, passage.text]));
  return sentences.flatMap((sentence) => {
    const cited = sentence.cites.flatMap((handle) => textOf.get(handle) ?? []);
    return unstatedFigures(sentence.text, cited).length === 0
      ? []
      : [{ number: sentence.number, hints: [FIGURE_HINT] }];
  });
}

/** The sentences flagged by the figure rule and by the checker, in reading order, one entry each with every hint that applies. */
export function mergeFlags(
  figures: readonly FlaggedSentence[],
  unsupported: readonly UnsupportedVerdict[],
): readonly FlaggedSentence[] {
  const hints = new Map<number, string[]>();
  for (const flag of figures) hints.set(flag.number, [...flag.hints]);
  for (const verdict of unsupported)
    hints.set(verdict.number, [...(hints.get(verdict.number) ?? []), UNSUPPORTED_HINTS[verdict.kind]]);
  return [...hints.entries()]
    .sort(([first], [second]) => first - second)
    .map(([number, list]) => ({ number, hints: list }));
}

const REWRITE_INSTRUCTIONS = [
  'REVISION AFTER A SUPPORT CHECK. A reader of your previous draft would find sentences that the passages you cited do not support. The context has two more items, both data: "check-problems" lists each such sentence and what to do about it, and "previous-draft" is the complete draft you wrote.',
  'Return the complete corrected answer in the same shape. For each listed sentence, remove it, or rewrite it to say only what a passage you cite states, with that passage\'s own figures. Keep every other sentence exactly as it was. If nothing the passages support is left to say, answer {"kind":"not_covered","text":"","cites":[]}. All the other rules above still hold.',
].join('\n');

/** The writer's role for the one rewrite a flagged draft earns: its own, marked as a revision. The harness gives it no repair. */
export function rewriteRole(role: ReasoningRole<InhabitantAnswer>): ReasoningRole<InhabitantAnswer> {
  return {
    ...role,
    version: `${role.version}.fix`.slice(0, 32),
    instructions: `${role.instructions}\n\n${REWRITE_INSTRUCTIONS}`,
  };
}

/**
 * What a rewrite adds to the writer's context: each flagged sentence, located by its own words, with the fixed hints that apply,
 * and the draft they refer to.
 */
export function rewriteItems(
  sentences: readonly SentenceUnderCheck[],
  flagged: readonly FlaggedSentence[],
  previous: Pick<InhabitantAnswer, 'kind' | 'text' | 'cites'>,
): ReasoningContext['items'] {
  const textOf = new Map(sentences.map((sentence) => [sentence.number, sentence.text]));
  const lines = flagged.map((flag) => `Sentence "${textOf.get(flag.number) ?? ''}": ${flag.hints.join(' ')}`);
  return [
    { ref: 'check:problems', kind: 'check_problems', text: lines.join('\n') },
    { ref: 'check:previous-draft', kind: 'previous_draft', text: JSON.stringify(previous) },
  ];
}

/** The passages as the checker is shown them: their handle and words. */
export const supportPassagesOf = (ground: readonly GroundPassage[]): readonly SupportPassage[] =>
  ground.map(({ handle, text }) => ({ handle, text }));
