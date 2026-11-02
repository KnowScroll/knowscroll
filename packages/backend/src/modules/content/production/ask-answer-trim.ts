import { FIELD_LIMITS } from '@knowscroll/scroll-model';
import { COPY_RUN_WORDS, copiedWordMask, copyWords, type AuthoredScroll } from '@knowscroll/scroll-model/producer';
import type { AdmissionIssue } from '../application/ports.js';
import { rebuildWithout, withLeaningSentencesRemoved } from './ask-answer-rebuild.js';
import { DIRECT_ANSWER_LOST_CODE, leansOnPrevious } from './ask-answer-shape.js';
import { placedSentencesOfAnswer, type PlacedSentence, type StatementPlace } from './ask-support.js';

/**
 * What code takes out of the writer's draft of the answer to a question, and puts in its place, before the draft is compiled and
 * checked (D-347 to D-350). The support check then reads what could be served. Pure: no model, no clock.
 */

/** The title given to an answer whose own title cannot be served when the person's question cannot stand as one. */
export const FALLBACK_TITLE = 'About your question';

/** The dek given to an answer whose own dek cannot be served. It states no fact; the stored document needs a dek of ten characters or more. */
export const NEUTRAL_DEK = 'A short answer to your question.';

/** The two lines code writes itself when the writer's cannot be served. Neither holds a word the model wrote. */
export interface CodeMadeLines {
  readonly title: string;
  readonly dek: string;
}

/** What the trim needs to know about one job: the material the copy check compares against, and the lines to put in. */
export interface TrimRules {
  /** The word shingles of the passages the copy check compares a text against (`copyMaterial`). */
  readonly copyMaterial: ReadonlySet<string>;
  readonly lines: CodeMadeLines;
}

/** How much code changed in a draft: counts and flags, never a sentence. */
export interface TrimCounts {
  /** Sentences taken out because they repeat a run of `COPY_RUN_WORDS` words of a passage. */
  readonly copied: number;
  /** Sentences taken out because they lean on one that was taken out, or lean with nothing before them in the answer. */
  readonly leaning: number;
  readonly titleReplaced: boolean;
  readonly dekReplaced: boolean;
}

/** A draft after the trim, ready to compile. */
export interface PreparedAnswer {
  readonly authored: AuthoredScroll;
  /** For each block of `authored`, the index the block had in the draft the writer wrote, so a finding can be located there. */
  readonly blockOrigin: readonly number[];
  /** What was changed; absent when the draft is as the writer wrote it. */
  readonly counts?: TrimCounts;
  /** Findings of the trim that only the writer can put right (the opening paragraph was taken out whole). */
  readonly issues: readonly AdmissionIssue[];
}

/** The draft as the writer wrote it: nothing taken out. */
export const unchanged = (answer: AuthoredScroll): PreparedAnswer => ({
  authored: answer,
  blockOrigin: answer.blocks.map((_block, index) => index),
  issues: [],
});

/** The title code makes from a person's question: their words, cut at a word to the title limit, or {@link FALLBACK_TITLE}. */
export function titleFromQuestion(question: string | undefined, usable: (candidate: string) => boolean): string {
  const whole = (question ?? '').replace(/\s+/gu, ' ').trim().normalize('NFC');
  const candidate = whole.length <= FIELD_LIMITS.titleChars ? whole : cutAtWord(whole, FIELD_LIMITS.titleChars);
  return candidate !== '' && usable(candidate) ? candidate : FALLBACK_TITLE;
}

/** `text` cut after a whole word to at most `max` characters, ending in an ellipsis; empty when not even the first word fits. */
function cutAtWord(text: string, max: number): string {
  let kept = '';
  for (const word of text.split(' ')) {
    const next = kept === '' ? word : `${kept} ${word}`;
    if (next.length > max - 1) break;
    kept = next;
  }
  const trimmed = kept.replace(/[\s,;:–—-]+$/u, '');
  return trimmed === '' ? '' : `${trimmed}…`;
}

/** Sentences that are one text for the copy check: a list reads as one passage, since the check runs over its items joined. */
const copyGroupOf = (place: StatementPlace): string =>
  'item' in place ? `item:${String(place.block)}` : place.field + ('block' in place ? `:${String(place.block)}` : '');

/**
 * The numbers of the sentences that hold a word of a copied run. A run may cross the end of a sentence, so the copy check is
 * done over the words of the whole text (a paragraph, a list, a callout's text, the title, the dek) and each sentence is marked
 * when any of its words is in a run. The check is the compile's: the same words and the same shingles.
 */
export function copiedSentenceNumbers(
  sentences: readonly PlacedSentence[],
  material: ReadonlySet<string>,
): ReadonlySet<number> {
  const groups = new Map<string, PlacedSentence[]>();
  for (const sentence of sentences) {
    const key = copyGroupOf(sentence.place);
    groups.set(key, [...(groups.get(key) ?? []), sentence]);
  }
  const copied = new Set<number>();
  for (const group of groups.values()) {
    const wordsOf = group.map((sentence) => copyWords(sentence.text));
    const mask = copiedWordMask(wordsOf.flat(), material, COPY_RUN_WORDS);
    let offset = 0;
    group.forEach((sentence, index) => {
      const length = wordsOf[index]!.length;
      if (mask.slice(offset, offset + length).some(Boolean)) copied.add(sentence.number);
      offset += length;
    });
  }
  return copied;
}

/**
 * The draft without what code can take out of it (D-347 to D-350):
 * - every sentence that holds a word of a run of `COPY_RUN_WORDS` words copied from a passage (a copied title or dek is replaced
 *   by the code-made line instead);
 * - the first sentence of the answer when it opens with a pointer, since it has nothing before it to lean on;
 * - every kept sentence that opens with a pointer right after a sentence that was taken out, and so on until none is left.
 *
 * The blocks are rebuilt as in the drop of D-310: a block left with no sentence goes, a list left with one item becomes a
 * paragraph, and a heading with nothing left under it goes. Nothing is refused here except by the finding
 * `direct_answer_lost`: the opening paragraph, the direct answer, had every sentence taken out. The length and the limits callout are
 * left to the compile, which sees the answer as it would be served.
 *
 * @param answer the draft the writer authored
 * @param rules the copy material and the lines to put in for a title or a dek that cannot be served
 */
export function trimAskAnswer(answer: AuthoredScroll, rules: TrimRules): PreparedAnswer {
  const sentences = placedSentencesOfAnswer(answer);
  const copied = copiedSentenceNumbers(sentences, rules.copyMaterial);
  const inBlock = (sentence: PlacedSentence) => 'block' in sentence.place;
  const copiedInBlocks = sentences.filter((sentence) => inBlock(sentence) && copied.has(sentence.number));
  const opening = sentences.find((sentence) => inBlock(sentence) && sentence.label !== true);
  const leaningOpening = opening !== undefined && !copied.has(opening.number) && leansOnPrevious(opening.text);
  const titleReplaced = sentences.some((sentence) => sentence.place.field === 'title' && copied.has(sentence.number));
  const dekReplaced = sentences.some((sentence) => sentence.place.field === 'dek' && copied.has(sentence.number));
  if (copiedInBlocks.length === 0 && !leaningOpening && !titleReplaced && !dekReplaced) return unchanged(answer);

  const removing = new Set(copiedInBlocks.map((sentence) => sentence.number));
  if (leaningOpening) removing.add(opening.number);
  const removed = withLeaningSentencesRemoved(sentences, removing);
  const { blocks, origin } = rebuildWithout(answer, sentences, removed);

  const directAnswer = answer.blocks.findIndex((block) => block.type === 'paragraph');
  const directAnswerLost = directAnswer >= 0 && !origin.includes(directAnswer);
  return {
    authored: {
      title: titleReplaced ? rules.lines.title : answer.title,
      dek: dekReplaced ? rules.lines.dek : answer.dek,
      blocks: [...blocks],
    },
    blockOrigin: origin,
    counts: {
      copied: copiedInBlocks.length,
      leaning: removed.size - copiedInBlocks.length,
      titleReplaced,
      dekReplaced,
    },
    issues: directAnswerLost ? [{ code: DIRECT_ANSWER_LOST_CODE, path: `blocks.${String(directAnswer)}` }] : [],
  };
}
