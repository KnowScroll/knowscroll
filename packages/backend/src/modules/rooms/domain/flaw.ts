import { createHash } from 'node:crypto';
import { FlawPayloadSchema, type FlawPayload, type PassageCitation } from './rituals.js';

/**
 * Spot the flaw (R3 E, D-176): a passage of a library Scroll with one sentence altered. Code owns everything that makes it
 * a puzzle with a key: it picks the passage, picks which sentence to alter, keeps the Scroll's own sentence as the answer,
 * and checks what a model proposed for that one sentence. The model never sees the key's position as a choice and never
 * writes more than the altered sentence. Pure: no database, clock or network.
 */

/** The longest sentence a puzzle shows, in characters (the wire contract's bound). */
export const SENTENCE_MAX_CHARS = 320;
/** A passage shows this many consecutive sentences, or fewer when its block has fewer; never fewer than three. */
const WINDOW_SENTENCES = 4;
const MIN_SENTENCES = 3;
/** A sentence too short to hold a checkable claim, or too long to read at a glance, is never altered or shown. */
const SENTENCE_MIN_CHARS = 20;
const ALTERABLE_MIN_WORDS = 6;

export interface Sentence {
  readonly text: string;
  /** UTF-16 offset of its first character in the block text. */
  readonly start: number;
  /** UTF-16 offset after its last character. */
  readonly end: number;
}

/** Words whose period does not end a sentence. */
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'vs.',
  'etc.',
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'st.',
  'no.',
  'approx.',
  'c.',
  'ca.',
  'fig.',
]);

/** Whether a sentence may end where a terminator is followed by a space and then `next`. */
function endsBefore(sentenceSoFar: string, next: string): boolean {
  if (!/^[A-Z0-9"“‘'(\[]/.test(next)) return false;
  const lastWord = sentenceSoFar.trim().split(/\s+/).at(-1)?.toLowerCase() ?? '';
  if (ABBREVIATIONS.has(lastWord)) return false;
  // An initial such as "J." or a single capital before a period is not an end.
  return !/^[a-z]\.$/i.test(lastWord);
}

/**
 * The sentences of a text with their offsets. A sentence ends at ".", "!" or "?" (and any closing quote or bracket) followed
 * by a space and a capital letter, digit or opening quote. Decimals ("3.5"), abbreviations ("e.g.") and initials do not end
 * one. Text with no such end is one sentence.
 */
export function splitSentences(text: string): readonly Sentence[] {
  const sentences: Sentence[] = [];
  const boundary = /[.!?]+["”’')\]]*\s+(?=\S)/g;
  let from = 0;
  for (let match = boundary.exec(text); match !== null; match = boundary.exec(text)) {
    const endOfSentence = match.index + match[0].trimEnd().length;
    const next = text.slice(match.index + match[0].length, match.index + match[0].length + 1);
    if (!endsBefore(text.slice(from, endOfSentence), next)) continue;
    sentences.push({ text: text.slice(from, endOfSentence), start: from, end: endOfSentence });
    from = match.index + match[0].length;
  }
  const rest = text.slice(from).trimEnd();
  if (rest.length > 0) sentences.push({ text: rest, start: from, end: from + rest.length });
  return sentences;
}

/** A stable non-negative integer from a key, so the same room and day always choose the same passage. */
export function seedOf(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0);
}

/** A Scroll's prose as the content read gives it (the part of `LibraryPassageSource` a puzzle needs). */
export interface PassageSource {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly { readonly blockId: string; readonly text: string }[];
}

/** What code chose to ask about: the passage, the sentence to alter, and the Scroll's own words as the key. */
export interface FlawPlan {
  readonly source: PassageCitation;
  /** The passage's sentences exactly as the Scroll has them. */
  readonly sentences: readonly string[];
  readonly flawIndex: number;
  readonly original: string;
}

const wordsOf = (text: string): readonly string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A sentence a reader could be wrong about: it states a number, a comparison, a cause or an absolute. */
const CLAIM_CUE =
  /\d|\b(because|more|less|most|least|larger|smaller|faster|slower|hotter|colder|always|never|only|all|every|both|causes?|due to|than)\b/i;

const readable = (sentence: Sentence): boolean =>
  sentence.text.length >= SENTENCE_MIN_CHARS && sentence.text.length <= SENTENCE_MAX_CHARS;

/** Every window of three or four consecutive readable sentences in one block, in order. */
function windowsOf(sentences: readonly Sentence[]): readonly { readonly from: number; readonly size: number }[] {
  const size = Math.min(WINDOW_SENTENCES, sentences.length);
  if (size < MIN_SENTENCES) return [];
  const found: { from: number; size: number }[] = [];
  for (let from = 0; from + size <= sentences.length; from += 1)
    if (sentences.slice(from, from + size).every(readable)) found.push({ from, size });
  return found;
}

/**
 * Chooses a passage and the sentence to alter, by code and by `seed`. A Scroll in `avoid` (used lately) is passed over
 * unless it is all there is. The sentence to alter is one that states something checkable (a number, a comparison, a cause)
 * when the passage has one, else any sentence of six words or more. Nothing is chosen when no block has three readable
 * sentences in a row, or no sentence in the passage can be altered: then there is no puzzle that day.
 */
export function planFlaw(
  sources: readonly PassageSource[],
  seed: number,
  avoid: ReadonlySet<string> = new Set(),
): FlawPlan | undefined {
  const candidates = sources.flatMap((source) =>
    source.blocks.flatMap((block) => {
      const sentences = splitSentences(block.text);
      return windowsOf(sentences).map((window) => ({ source, block, sentences, ...window }));
    }),
  );
  const fresh = candidates.filter((candidate) => !avoid.has(candidate.source.assetId));
  const pool = fresh.length > 0 ? fresh : candidates;
  for (let tried = 0; tried < pool.length; tried += 1) {
    const chosen = pool[(seed + tried) % pool.length]!;
    const shown = chosen.sentences.slice(chosen.from, chosen.from + chosen.size);
    const alterable = shown.flatMap((sentence, index) =>
      wordsOf(sentence.text).length >= ALTERABLE_MIN_WORDS ? [index] : [],
    );
    const checkable = alterable.filter((index) => CLAIM_CUE.test(shown[index]!.text));
    const picks = checkable.length > 0 ? checkable : alterable;
    if (picks.length === 0) continue;
    const flawIndex = picks[seed % picks.length]!;
    const first = shown[0]!;
    const last = shown.at(-1)!;
    const quote = chosen.block.text.slice(first.start, last.end);
    return {
      source: {
        assetId: chosen.source.assetId,
        assetRevision: chosen.source.assetRevision,
        blockId: chosen.block.blockId,
        start: first.start,
        end: last.end,
        quoteHash: createHash('sha256').update(quote).digest('hex'),
      },
      sentences: shown.map((sentence) => sentence.text),
      flawIndex,
      original: shown[flawIndex]!.text,
    };
  }
  return undefined;
}

export type AlterationProblem =
  | 'empty'
  | 'control'
  | 'too_long'
  | 'same'
  | 'length'
  | 'many_sentences'
  | 'not_a_sentence'
  | 'link'
  | 'tell'
  | 'too_different';

/** Words that announce a mistake, which would give the puzzle away; they count only when the original has none of them. */
const TELL = /\b(false|wrong|incorrect|untrue|not true|mistake|error|flaw|myth)\b/i;
const LINK = /https?:|www\.|\.(com|org|net|io)\b|@/i;

/** The share of the altered sentence's words that the original also has: a one-fact edit keeps most of them. */
const MIN_SHARED = 0.5;
const LENGTH_RATIO = { min: 0.6, max: 1.5 };

/**
 * Whether a model's altered sentence may stand in the original's place, or why not. The alteration must be one sentence of
 * the same kind as the original: not the original, not much longer or shorter, mostly the same words, no link, and no
 * word that says it is wrong. Code owns this judgement; the model only proposes.
 */
export function alterationProblem(original: string, altered: string): AlterationProblem | undefined {
  const text = altered.trim();
  if (text.length === 0) return 'empty';
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) return 'control';
  if (text.length > SENTENCE_MAX_CHARS) return 'too_long';
  const originalWords = wordsOf(original);
  const alteredWords = wordsOf(text);
  if (originalWords.join(' ') === alteredWords.join(' ')) return 'same';
  const ratio = text.length / original.length;
  if (ratio < LENGTH_RATIO.min || ratio > LENGTH_RATIO.max) return 'length';
  if (splitSentences(text).length !== 1) return 'many_sentences';
  if (!/[.!?]["”’')\]]*$/.test(text) || /^[a-z]/.test(text)) return 'not_a_sentence';
  if (LINK.test(text)) return 'link';
  if (TELL.test(text) && !TELL.test(original)) return 'tell';
  const known = new Set(originalWords);
  const shared = alteredWords.filter((word) => known.has(word)).length;
  return shared / alteredWords.length < MIN_SHARED ? 'too_different' : undefined;
}

/** The stored puzzle: the plan with the altered sentence in the flaw's place. Parsed, so a plan that cannot be shown throws. */
export function flawPayload(plan: FlawPlan, altered: string): FlawPayload {
  const sentences = plan.sentences.map((sentence, index) => (index === plan.flawIndex ? altered.trim() : sentence));
  return FlawPayloadSchema.parse({
    sentences,
    flawIndex: plan.flawIndex,
    original: plan.original,
    source: plan.source,
  });
}

/**
 * Whether a cited passage still says what it did: the range lies inside the block's text, its words hash to the recorded
 * quote, and, for a puzzle, the Scroll's own sentences are the shown ones with the original in the flaw's place. A Scroll that
 * was corrected since fails it.
 */
export function citationHolds(blockText: string, payload: FlawPayload): boolean {
  const { source } = payload;
  if (source.start >= source.end || source.end > blockText.length) return false;
  const quote = blockText.slice(source.start, source.end);
  if (createHash('sha256').update(quote).digest('hex') !== source.quoteHash) return false;
  const own = splitSentences(quote).map((sentence) => sentence.text);
  const expected = payload.sentences.map((sentence, index) =>
    index === payload.flawIndex ? payload.original : sentence,
  );
  return own.length === expected.length && own.every((sentence, index) => sentence === expected[index]);
}
