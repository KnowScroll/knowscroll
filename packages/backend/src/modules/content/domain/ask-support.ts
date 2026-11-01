/**
 * The support check of an ask order's answer (D-250): after the writer, a second model reads each sentence of the answer
 * against the passages its block cites and says which sentences those passages do not support. It only proposes. Code
 * validates its reply, decides what a verdict changes and never edits an answer. Pure; the production job asks the model.
 */

/** Why a sentence is not supported. Code owns the repair hint of each kind, so the writer is never told model prose as an instruction. */
export const UNSUPPORTED_KINDS = ['not_stated', 'contradicted', 'goes_beyond'] as const;
export type UnsupportedKind = (typeof UNSUPPORTED_KINDS)[number];

/** One sentence of an answer as the checker is shown it: its number, the handles of the passages its block cites, and its words. */
export interface SentenceUnderCheck {
  /** 1-based, in reading order across the whole answer. */
  readonly number: number;
  readonly text: string;
  /** The handles (`e1`) of the passages the sentence's block cites. */
  readonly cites: readonly string[];
}

/** What the checker said about one sentence. A supported sentence carries the words of the passage that state it. */
export type SentenceVerdict =
  | { readonly number: number; readonly verdict: 'supported'; readonly quote: string }
  | {
      readonly number: number;
      readonly verdict: 'unsupported';
      readonly kind: UnsupportedKind;
      /** One or two plain sentences: which words are not supported. An operator note and a hint's data, never shown to a reader. */
      readonly problem: string;
    }
  | { readonly number: number; readonly verdict: 'no_claim' };

export type UnsupportedVerdict = Extract<SentenceVerdict, { verdict: 'unsupported' }>;

/**
 * One support check as the production job records it. `unchecked` means the checker gave no usable answer (it failed, was
 * refused, or its reply stayed invalid after the harness's one repair), so nothing is known; `code` says why and never holds
 * provider text. The record keeps sentence numbers and kinds, never the sentences or the checker's words: the job outlives an
 * erasure of the question, and an answer may echo it (D-231).
 */
export interface SupportRecord {
  /** The writer's draft that was checked: 1, or 2 when the writer repaired the first after a finding. */
  readonly draft: 1 | 2;
  readonly kind: 'checked' | 'unchecked';
  readonly sentences: number;
  readonly unsupported: readonly { readonly number: number; readonly kind: UnsupportedKind }[];
  readonly code?: string;
}

/** The sentences the checker found unsupported. */
export function unsupportedOf(verdicts: readonly SentenceVerdict[]): readonly UnsupportedVerdict[] {
  return verdicts.filter((verdict): verdict is UnsupportedVerdict => verdict.verdict === 'unsupported');
}

/** The record of a check that gave verdicts. */
export function checkedRecord(draft: 1 | 2, verdicts: readonly SentenceVerdict[]): SupportRecord {
  return {
    draft,
    kind: 'checked',
    sentences: verdicts.length,
    unsupported: unsupportedOf(verdicts).map(({ number, kind }) => ({ number, kind })),
  };
}

/** The record of a check that gave no usable answer. */
export function uncheckedRecord(draft: 1 | 2, sentences: number, code: string): SupportRecord {
  return { draft, kind: 'unchecked', sentences, unsupported: [], code };
}

/**
 * Whether an answer may be served on this check. Only a check that gave verdicts and found nothing unsupported passes:
 * no usable check is a refusal, because an ask order has no human review (D-250).
 */
export const passes = (record: SupportRecord): boolean => record.kind === 'checked' && record.unsupported.length === 0;

/** The repair hint of each kind. Fixed here: the hint never echoes the checker's or the writer's words. */
export const UNSUPPORTED_HINTS: Readonly<Record<UnsupportedKind, string>> = {
  not_stated: 'No passage you cite states this. Remove the sentence, or say only what a cited passage states.',
  contradicted: 'A passage you cite says otherwise. Correct the sentence to what the passage says, or remove it.',
  goes_beyond:
    'A passage you cite says something narrower or different. Say only what it states, without the extra claim.',
};

/** Abbreviations whose full stop does not end a sentence; a segment that ends in one is joined to the next. */
const ABBREVIATION_END = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e|approx|Fig|Figs|Eq)\.$/u;

/**
 * The sentences of one text, in order. Sentence ends come from the platform's segmenter; a segment that stops at an
 * abbreviation ("Dr.", "e.g.", "Fig.") is joined to the next one, so the checker is never shown a half sentence.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let carried = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    const joined = `${carried}${segment}`;
    if (ABBREVIATION_END.test(joined.trimEnd())) {
      carried = joined;
      continue;
    }
    carried = '';
    const trimmed = joined.trim();
    if (trimmed !== '') sentences.push(trimmed);
  }
  const rest = carried.trim();
  if (rest !== '') sentences.push(rest);
  return sentences;
}

/** The words of a text, lower case, with punctuation and typographic variants set aside, so a quote compares by its words. */
export function wordsOf(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/gu, ''))
    .filter((word) => word !== '');
}

/** Whether the words of `quote` stand together, in order, in `text`. A quote that is not in the passage proves nothing. */
export function quoteIsIn(quote: string, text: string): boolean {
  const wanted = wordsOf(quote);
  if (wanted.length === 0) return false;
  const have = wordsOf(text);
  for (let start = 0; start + wanted.length <= have.length; start += 1)
    if (wanted.every((word, offset) => have[start + offset] === word)) return true;
  return false;
}

/** The fewest words a quote may have: a single word proves nothing about a sentence. */
export const MIN_QUOTE_WORDS = 3;

/** Whether a sentence states a figure. A sentence with a number is a claim, whatever the checker thinks. */
export const statesFigure = (text: string): boolean => /\p{N}/u.test(text);

/** Whether more than half the sentences were marked as stating no fact: an answer states facts, so the reply is not credible. */
export const tooManyNoClaims = (verdicts: readonly { readonly verdict: string }[]): boolean =>
  verdicts.filter((verdict) => verdict.verdict === 'no_claim').length > Math.floor(verdicts.length / 2);
