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

/**
 * Whether a quote has enough words. Words are letters and numbers (`wordsOf`): the pieces between spaces are not words, so a
 * dash or a mark standing alone adds nothing.
 */
export const hasEnoughWords = (quote: string): boolean => wordsOf(quote).length >= MIN_QUOTE_WORDS;

/** Words too common to show that two texts are about the same thing, and the spelled numbers (figures have their own rule). */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'about above across after again against all almost along also although always among and any are around because been before being below ' +
    'between both but can could did does doing down during each either else enough even ever every few for from further had has have having ' +
    'her here hers him his how however into its itself just least less like made make many may might more most much must near neither nor ' +
    'not now off often once only onto other others our ours out over own per quite rather same shall she should since some such than that ' +
    'the their theirs them then there these they this those though through thus too under until upon very was were what when whenever where ' +
    'whereas whether which while who whom whose why will with within without would yet you your yours ' +
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty ' +
    'thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion'
  ).split(' '),
);

/** How many letters of a word stand for it: "begins" and "beginning" are the same key word. */
const STEM_LETTERS = 5;

/**
 * The key words of a text: its words (letters and numbers) of three or more letters that are not common, each cut to its
 * first five letters, without repeats. Two texts that share key words are about the same thing; a text that shares none
 * with another says nothing about it.
 */
export function contentStems(text: string): ReadonlySet<string> {
  const stems = new Set<string>();
  for (const word of wordsOf(text)) {
    if (word.length >= 3 && !STOP_WORDS.has(word) && /\p{L}/u.test(word)) stems.add(word.slice(0, STEM_LETTERS));
  }
  return stems;
}

/** How many key words two texts share. */
export function sharedStems(first: string, second: string): number {
  const other = contentStems(second);
  return [...contentStems(first)].filter((stem) => other.has(stem)).length;
}

/** The key words a quote must share with the text it is given for. */
export const MIN_SHARED_WORDS = 2;

/**
 * Whether a quote is about a text: it carries at least {@link MIN_SHARED_WORDS} of the text's key words, or all of them when
 * the text has fewer (a heading of one key word needs one). This is what ties a verdict's quote to the sentence (or the
 * question) it was given for; whether the quote then supports the sentence is for the checker to say.
 */
export function isAbout(quote: string, text: string): boolean {
  return sharedStems(quote, text) >= Math.min(MIN_SHARED_WORDS, contentStems(text).size);
}

/** Numbers written in words ("twenty-one", "a hundred"). A figure written in words is a figure. */
const SPELLED_NUMBER =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?)\b/iu;

/** Whether a sentence states a figure, in digits or in words. A sentence with a number is a claim, whatever the checker thinks. */
export const statesFigure = (text: string): boolean => /\p{N}/u.test(text) || SPELLED_NUMBER.test(text);

/** Whether a sentence is a question put to the reader: it asserts nothing. */
export const isQuestion = (text: string): boolean => /\?["'”’)\]]*\s*$/u.test(text.trim());

/** Plain admissions of what the pages or the answer do not hold: a sentence that says so asserts nothing about the subject. */
const GAP_PATTERNS: readonly RegExp[] = [
  /\b(?:pages?|passages?|sources?|material|text)\b[^.?!]{0,40}\b(?:do not|does not|don['’]t|doesn['’]t|never|cannot|can['’]t|say nothing|are silent|leave out)\b/iu,
  /\b(?:this|that|it|the answer|this answer|this explanation|this picture|this story)\s+(?:cannot|can['’]t|can not|does not|doesn['’]t|do not|don['’]t)\s+(?:tell|say|cover|explain|show|settle|answer|give|state|include|speak|hold)\b/iu,
  /\b(?:this|that|it|the answer|this answer|this explanation|this picture|this story)\s+(?:ignores|leaves out|omits|skips|says nothing)\b/iu,
  /\bnothing in (?:the|these|those) (?:pages?|passages?|sources?)\b/iu,
];

/** Whether a sentence names a gap ("the pages do not say...", "this cannot tell us...") instead of stating a fact. */
export const namesTheGap = (text: string): boolean => GAP_PATTERNS.some((pattern) => pattern.test(text));

/**
 * Whether a sentence may be marked as stating no fact, on grounds code can see: it is a question, or it names a gap, or it
 * has no figure and shares no key word with any passage it cites (a label or a transition: nothing a passage could support
 * or contradict). Any other sentence states something and must be judged.
 */
export function mayStateNoFact(sentence: string, citedTexts: readonly string[]): boolean {
  if (isQuestion(sentence) || namesTheGap(sentence)) return true;
  if (statesFigure(sentence)) return false;
  const cited = new Set(citedTexts.flatMap((text) => [...contentStems(text)]));
  return ![...contentStems(sentence)].some((stem) => cited.has(stem));
}

/** Whether more than half the sentences were marked as stating no fact: an answer states facts, so the reply is not credible. */
export const tooManyNoClaims = (verdicts: readonly { readonly verdict: string }[]): boolean =>
  verdicts.filter((verdict) => verdict.verdict === 'no_claim').length > Math.floor(verdicts.length / 2);
