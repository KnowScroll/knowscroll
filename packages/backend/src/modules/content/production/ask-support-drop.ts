import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { MIN_SERVED_SENTENCES, splitSentences, type SentenceVerdict } from '../domain/ask-support.js';
import { isCodeMadeLimits } from './ask-answer-limits.js';
import { rebuildWithout, withLeaningSentencesRemoved } from './ask-answer-rebuild.js';
import { hasCodeMadeDek } from './ask-answer-shape.js';
import type { CodeMadeLines } from './ask-answer-trim.js';
import { placedSentencesOfAnswer, type PlacedSentence } from './ask-support.js';

/**
 * Why an answer with sentences that still fail the support check cannot be served without them (D-310). Each is a code, never a
 * sentence. `title_or_dek_flagged`: the title or the dek was flagged and no line was given to replace it (D-351).
 * `no_direct_answer`: no sentence of the opening paragraph is supported. `too_few_supported`: fewer than {@link MIN_SERVED_SENTENCES}
 * sentences of reading text are supported. `no_limit_callout`: the callout code wrote is not the last block, which only a bug or an answer that
 * code did not prepare can cause (D-371); the check can no longer cause it. `rebuilt_invalid`: what is left
 * is not a valid answer that reads back as the sentences that were kept.
 */
export type DropRefusal =
  | 'verdicts_incomplete'
  | 'title_or_dek_flagged'
  | 'no_direct_answer'
  | 'too_few_supported'
  | 'no_limit_callout'
  | 'rebuilt_invalid';

export type DropOutcome =
  /**
   * The answer without the sentences the check found unsupported; `dropped` counts them (a number, never their words), and the
   * flags say whether the title or the dek was replaced by the code-made line.
   */
  | {
      readonly kind: 'kept';
      readonly authored: AuthoredScroll;
      readonly dropped: number;
      readonly titleReplaced: boolean;
      readonly dekReplaced: boolean;
    }
  | { readonly kind: 'refused'; readonly code: DropRefusal };

const refused = (code: DropRefusal): DropOutcome => ({ kind: 'refused', code });

/**
 * Whether the only sentences the check found unsupported are the title and the dek: the two lines code can replace without the
 * writer (D-351, D-352). False when nothing was flagged.
 */
export function onlyTitleOrDekFlagged(answer: AuthoredScroll, verdicts: readonly SentenceVerdict[]): boolean {
  const flagged = placedSentencesOfAnswer(answer).filter(
    (sentence) => verdicts.find((verdict) => verdict.number === sentence.number)?.verdict === 'unsupported',
  );
  return (
    flagged.length > 0 &&
    flagged.every((sentence) => sentence.place.field === 'title' || sentence.place.field === 'dek')
  );
}

/**
 * The answer without the sentences that failed its support check (D-310). Pure: no model, no clock.
 *
 * Every sentence of a paragraph, a list, a callout or a heading whose verdict is `unsupported` is taken out of its text. So is every
 * kept sentence that opens with a pointer ("This is why...", D-309) right after one that was taken out, since it would point at
 * nothing; that repeats until none is left. The blocks are rebuilt: a block left with no sentence is removed (a list left with one
 * item becomes a paragraph), and so is a heading with nothing left in its section. The closing limits callout, which code wrote
 * (D-371), has no sentence in the check, so it is never taken out, and it belongs to no section.
 * A title or a dek that was flagged cannot be taken out, so it is replaced by the line in `lines` (D-351); without `lines` the answer
 * is refused. The answer is served only if
 * - the first paragraph, the direct answer, keeps at least one supported sentence,
 * - at least {@link MIN_SERVED_SENTENCES} sentences of reading text (not a title, a heading or a callout's title, and not a dek that
 *   code made) are supported,
 * - the callout code wrote is the last block, as code placed it, and
 * - what is left is a valid answer whose sentences read back as exactly the ones that were kept, so every sentence served has the
 *   verdict it was checked with, except the lines code made.
 *
 * @param answer the authored answer the verdicts were given for
 * @param verdicts one for each sentence of `answer` (`placedSentencesOfAnswer`)
 * @param lines the title and dek to put in for one that was flagged
 */
export function dropFlagged(
  answer: AuthoredScroll,
  verdicts: readonly SentenceVerdict[],
  lines?: CodeMadeLines,
): DropOutcome {
  const sentences = placedSentencesOfAnswer(answer);
  const verdictOf = new Map(verdicts.map((verdict) => [verdict.number, verdict.verdict]));
  if (sentences.some((sentence) => !verdictOf.has(sentence.number))) return refused('verdicts_incomplete');
  const flagged = sentences.filter((sentence) => verdictOf.get(sentence.number) === 'unsupported');
  const flaggedAt = (field: 'title' | 'dek') => flagged.some((sentence) => sentence.place.field === field);
  const titleReplaced = flaggedAt('title');
  const dekReplaced = flaggedAt('dek');
  if ((titleReplaced || dekReplaced) && lines === undefined) return refused('title_or_dek_flagged');
  const removed = withLeaningSentencesRemoved(
    sentences,
    new Set(flagged.filter((sentence) => 'block' in sentence.place).map((sentence) => sentence.number)),
  );

  const supported = sentences.filter(
    (sentence) =>
      verdictOf.get(sentence.number) === 'supported' && !removed.has(sentence.number) && !isCodeMade(sentence, answer),
  );
  const directAnswer = answer.blocks.findIndex((block) => block.type === 'paragraph');
  if (!supported.some((sentence) => sentence.place.field === 'paragraph' && sentence.place.block === directAnswer))
    return refused('no_direct_answer');
  if (supported.filter((sentence) => sentence.label !== true).length < MIN_SERVED_SENTENCES)
    return refused('too_few_supported');

  const rebuilt = rebuildWithout(answer, sentences, removed);
  if (!isCodeMadeLimits(rebuilt.blocks.at(-1))) return refused('no_limit_callout');

  const title = titleReplaced && lines !== undefined ? lines.title : answer.title;
  const dek = dekReplaced && lines !== undefined ? lines.dek : answer.dek;
  const candidate = AuthoredScroll.safeParse({ title, dek, blocks: rebuilt.blocks });
  if (!candidate.success) return refused('rebuilt_invalid');
  // A sentence not taken out is served unless the block it stood in was removed whole (a callout's title goes with its text);
  // a replaced title or dek is served as the line that replaced it.
  const kept = new Set(rebuilt.origin);
  const expected = [
    ...(titleReplaced ? splitSentences(title) : textsOf(sentences, 'title')),
    ...(dekReplaced ? splitSentences(dek) : textsOf(sentences, 'dek')),
    ...sentences
      .filter(
        (sentence) => 'block' in sentence.place && !removed.has(sentence.number) && kept.has(sentence.place.block),
      )
      .map((sentence) => sentence.text),
  ];
  const actual = placedSentencesOfAnswer(candidate.data).map((sentence) => sentence.text);
  if (expected.length !== actual.length || expected.some((text, index) => text !== actual[index]))
    return refused('rebuilt_invalid');
  return { kind: 'kept', authored: candidate.data, dropped: removed.size, titleReplaced, dekReplaced };
}

/** The dek that code wrote states no fact and has no verdict worth counting, whatever the checker said of it (D-356). */
const isCodeMade = (sentence: PlacedSentence, answer: AuthoredScroll): boolean =>
  sentence.place.field === 'dek' && hasCodeMadeDek(answer);

const textsOf = (sentences: readonly PlacedSentence[], field: 'title' | 'dek'): string[] =>
  sentences.filter((sentence) => sentence.place.field === field).map((sentence) => sentence.text);
