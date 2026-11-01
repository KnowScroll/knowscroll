/**
 * The support check of an ask order's answer (D-250, D-263, D-265 to D-267): after the writer, a second model reads each sentence of the
 * answer against the passages its block cites and says which sentences those passages do not support. It only proposes.
 * Code validates the shape of its reply, judges each verdict on its own sentence, decides what a verdict changes and never
 * edits an answer. Pure; the production job asks the model.
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
  /**
   * The sentence is a title, a heading or the title of a callout: a label that names what follows. A label with no figure may
   * be marked as stating no fact without any other ground (D-266). A label that states a fact is judged like any sentence.
   */
  readonly label?: boolean;
}

/**
 * The rules code applies to one sentence's verdict. A verdict that breaks one is set aside and the sentence counts as
 * unsupported, because nothing shows that a cited passage states it (D-265). The code is kept; the checker's words are not.
 */
export const RULE_CODES = [
  'quote_too_short',
  'quote_not_in_cited_passages',
  'quote_not_about_sentence',
  'no_claim_without_ground',
  'too_many_no_claim',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

/** The note kept with a sentence that code set aside. Fixed here, so it never holds the checker's or the writer's words. */
export const RULE_PROBLEMS: Readonly<Record<RuleCode, string>> = {
  quote_too_short: 'The checker did not quote enough words of a cited passage to show that one states this sentence.',
  quote_not_in_cited_passages: 'The words the checker quoted for this sentence are not in any passage it cites.',
  quote_not_about_sentence: 'The words the checker quoted are in a cited passage but are about something else.',
  no_claim_without_ground:
    'The checker said this sentence states no fact, but it states one that a cited passage should support.',
  too_many_no_claim: 'The checker said too many sentences state no fact, so this one was not shown to be supported.',
};

/** What the checker said about one sentence. A supported sentence carries the words of the passage that state it. */
export type SentenceVerdict =
  | { readonly number: number; readonly verdict: 'supported'; readonly quote: string }
  | {
      readonly number: number;
      readonly verdict: 'unsupported';
      readonly kind: UnsupportedKind;
      /** One or two plain sentences: which words are not supported. An operator note and a hint's data, never shown to a reader. */
      readonly problem: string;
      /** Present when code, not the checker, found the sentence unsupported: the rule its verdict broke (D-265). */
      readonly code?: RuleCode;
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
  /** How many requests' worth of sentences the answer was split into (D-267). */
  readonly batches: number;
  readonly unsupported: readonly {
    readonly number: number;
    readonly kind: UnsupportedKind;
    readonly code?: RuleCode;
  }[];
  readonly code?: string;
}

/** The sentences the checker found unsupported. */
export function unsupportedOf(verdicts: readonly SentenceVerdict[]): readonly UnsupportedVerdict[] {
  return verdicts.filter((verdict): verdict is UnsupportedVerdict => verdict.verdict === 'unsupported');
}

/** The record of a check that gave verdicts. */
export function checkedRecord(draft: 1 | 2, verdicts: readonly SentenceVerdict[], batches: number): SupportRecord {
  return {
    draft,
    kind: 'checked',
    sentences: verdicts.length,
    batches,
    unsupported: unsupportedOf(verdicts).map(({ number, kind, code }) => ({
      number,
      kind,
      ...(code === undefined ? {} : { code }),
    })),
  };
}

/** The record of a check that gave no usable answer. */
export function uncheckedRecord(draft: 1 | 2, sentences: number, batches: number, code: string): SupportRecord {
  return { draft, kind: 'unchecked', sentences, batches, unsupported: [], code };
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

/**
 * The words of a text (D-263), lower case, with punctuation and typographic variants set aside, so a quote compares by its words:
 * curly and straight quotes and apostrophes, every dash, non-breaking and repeated spaces, case and the separators of a
 * figure ("4,096" is "4096") do not make two texts differ.
 */
export function wordsOf(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<=\p{N}),(?=\p{N}{3}(?!\p{N}))/gu, '')
    .replace(/[‘’‛ʼ′`´]/gu, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/gu, ''))
    .filter((word) => word !== '');
}

/** The marks a quote uses for words it leaves out: "..." or the single character, which becomes "..." once normalised. */
const ELISION = /\.{3,}|\.\s\.\s\./u;

/** The runs of words a quote is made of: what stands between its marks of elision, each as words (`wordsOf`). */
export function quoteParts(quote: string): string[][] {
  return quote
    .normalize('NFKC')
    .split(ELISION)
    .map(wordsOf)
    .filter((part) => part.length > 0);
}

/** Where `run` stands in `words` at or after `from`, or -1. */
function indexOfRun(words: readonly string[], run: readonly string[], from: number): number {
  for (let start = from; start + run.length <= words.length; start += 1)
    if (run.every((word, offset) => words[start + offset] === word)) return start;
  return -1;
}

/**
 * Whether the words of `quote` stand together, in order, in `text`. A quote that marks words it leaves out ("the Sun ... never
 * overhead") needs each part in the text, in that order. A quote that is not in the passage proves nothing.
 */
export function quoteIsIn(quote: string, text: string): boolean {
  const parts = quoteParts(quote);
  if (parts.length === 0) return false;
  const have = wordsOf(text);
  let from = 0;
  for (const part of parts) {
    const at = indexOfRun(have, part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** The fewest words a quote may have: a single word proves nothing about a sentence. */
export const MIN_QUOTE_WORDS = 3;

/** The fewest words of each part of a quote that leaves words out: a lone word between two marks proves nothing either. */
export const MIN_QUOTE_PART_WORDS = 2;

/**
 * Whether a quote has enough words. Words are letters and numbers (`wordsOf`): the pieces between spaces are not words, so a
 * dash or a mark standing alone adds nothing.
 */
export function hasEnoughWords(quote: string): boolean {
  const parts = quoteParts(quote);
  return (
    parts.reduce((total, part) => total + part.length, 0) >= MIN_QUOTE_WORDS &&
    parts.every((part) => part.length >= MIN_QUOTE_PART_WORDS)
  );
}

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

const LEAD_IN = String.raw`(?:(?:but|yet|and|so|however|also|still|note that|keep in mind that),?\s+)?`;
/** What a plain admission is about when it speaks of the answer itself. */
const ANSWER_SUBJECT = String.raw`(?:this|that|it|the answer|this answer|that answer|the explanation|this explanation|this account|this picture|this story)`;
/** What a plain admission is about when it speaks of the pages the answer rests on. */
const PAGES_SUBJECT = String.raw`(?:(?:the|these|those|this|our)\s+)?(?:available\s+)?(?:pages?|passages?|sources?|material|text)`;
const HEDGE = String.raw`(?:(?:also|still|simply|really|just)\s+)?`;
const NOT = String.raw`(?:cannot|can\s+not|can['’]t|will\s+not|won['’]t|does\s+not|do\s+not|doesn['’]t|don['’]t|did\s+not|never)`;
const GAP_VERBS =
  'tell|say|cover|explain|show|settle|answer|give|state|include|speak|hold|determine|establish|identify|calculate|choose|predict|measure|decide|prove|reveal|expose|specify|name|describe|address|resolve|offer|provide|mention';

const gapPattern = (body: string): RegExp => new RegExp(`^${LEAD_IN}${body}`, 'iu');

/** The few words, before a verb, that name what a short admission is about: "that detail", "the source-position detail". */
const SHORT_SUBJECT = String.raw`(?:that|this|the)\s+(?:[\p{L}\p{N}'’-]+\s+){1,3}?`;

/**
 * Plain admissions of what the pages or the answer do not hold, each anchored at the start of the sentence. The list is
 * small and fixed, and it is not a reading of the sentence: {@link continuesBeyondTheGap} then refuses a sentence that goes
 * on to say something else.
 */
const GAP_PATTERNS: readonly RegExp[] = [
  gapPattern(String.raw`${PAGES_SUBJECT}\s+${HEDGE}(?:${NOT}|says?\s+nothing|are\s+silent|leaves?\s+out)\b`),
  gapPattern(String.raw`${ANSWER_SUBJECT}\s+${HEDGE}${NOT}\s+(?:${GAP_VERBS})\b`),
  gapPattern(String.raw`${ANSWER_SUBJECT}\s+(?:ignores|leaves\s+out|omits|skips|says\s+nothing|leaves\s+aside)\b`),
  gapPattern(String.raw`nothing\s+in\s+(?:the|these|those)\s+(?:pages?|passages?|sources?)\b`),
  gapPattern(
    String.raw`${SHORT_SUBJECT}(?:remains?|stays?|is|are)\s+(?:unspecified|unstated|unexplained|not\s+(?:given|stated|covered|specified))\b[^.?!;:]{0,40}?\b(?:here|in\s+(?:this|the)\s+(?:answer|explanation|account|story|picture|pages?|passages?|sources?|material|text))\b`,
  ),
];

const SUBJECT_WORDS = String.raw`(?:the|a|an|this|that|these|those|it|its|they|their|he|she|we|there|then|no|nothing|every|everything|all|some|most|each)`;
const AUXILIARY_WORDS = String.raw`(?:is|are|was|were|has|have|had|does|do|did|will|would|can|could|may|might|must|should|remains?|stays?)`;

/**
 * What turns an admission into a sentence that says more (the whole sentence has to be the admission): a semicolon, colon,
 * dash or bracket; a word that opens a second clause (but, though, because, so...); a relative clause after a comma; and a
 * second clause after a comma or "and", seen as a new subject (a determiner, a pronoun or a capital) or, after "and", a
 * short phrase that ends in an auxiliary verb. "terrain, oceans, and local circulation" and "a partial update and a
 * broader redraw" continue the object of the admission; "and the Sun is overhead at the pole" does not.
 */
const CONTINUATIONS: readonly RegExp[] = [
  /[;:—–()]/u,
  /\s[-‑]\s/u,
  /\b(?:but|though|although|while|whereas|yet|because|since|so)\b/iu,
  /,\s*(?:which|who|whom|whose|where|when)\b/iu,
  new RegExp(String.raw`,\s*(?:and\s+)?${SUBJECT_WORDS}\b`, 'iu'),
  /,\s*(?:and\s+)?\p{Lu}/u,
  new RegExp(String.raw`\band\s+${SUBJECT_WORDS}\b(?:\s+\S+){0,3}?\s+${AUXILIARY_WORDS}\b`, 'iu'),
  new RegExp(String.raw`\band\s+\p{Lu}\p{L}*(?:\s+\S+){0,3}?\s+${AUXILIARY_WORDS}\b`, 'u'),
];

/** Whether the sentence goes on to say something besides an admission (the words that open it do not count). */
const continuesBeyondTheGap = (text: string): boolean => {
  const body = text.replace(new RegExp(`^${LEAD_IN}`, 'iu'), '');
  return CONTINUATIONS.some((pattern) => pattern.test(body));
};

/**
 * Whether a sentence names a gap ("the pages do not say...", "this cannot tell us...") and nothing else. It must begin with
 * one of a small fixed list of admissions and not go on to say anything more (D-266): "This explains the pattern, but it
 * does not give the height" and "The pages do not say why, but the Sun is overhead at the pole" state something, so they
 * are judged.
 */
export const namesTheGap = (text: string): boolean => {
  const trimmed = text.trim();
  return GAP_PATTERNS.some((pattern) => pattern.test(trimmed)) && !continuesBeyondTheGap(trimmed);
};

/** What shows, to code, that a sentence states no fact. */
export type NoClaimGround =
  /** A question put to the reader. */
  | 'question'
  /** A plain admission of a gap. */
  | 'gap'
  /** A title, a heading or a callout's title that names what follows and has no figure. */
  | 'label'
  /** A sentence with no figure that shares no key word with the passages it cites: a transition, nothing a passage could support. */
  | 'unshared';

/**
 * Why a sentence may be marked as stating no fact, from what code can see, or `undefined` when it may not: any other
 * sentence states something and must be judged. A figure makes a label or a transition a claim, in digits or in words.
 */
export function noClaimGround(
  sentence: Pick<SentenceUnderCheck, 'text' | 'label'>,
  citedTexts: readonly string[],
): NoClaimGround | undefined {
  if (isQuestion(sentence.text)) return 'question';
  if (statesFigure(sentence.text)) return undefined;
  if (namesTheGap(sentence.text)) return 'gap';
  if (sentence.label === true) return 'label';
  const cited = new Set(citedTexts.flatMap((text) => [...contentStems(text)]));
  return [...contentStems(sentence.text)].some((stem) => cited.has(stem)) ? undefined : 'unshared';
}

/** The rule a verdict breaks on its own sentence, or `undefined` when none: the quote must be real and about the sentence. */
function ruleBrokenBy(
  verdict: SentenceVerdict,
  sentence: SentenceUnderCheck,
  citedTexts: readonly string[],
): RuleCode | undefined {
  switch (verdict.verdict) {
    case 'unsupported':
      return undefined;
    case 'no_claim':
      return noClaimGround(sentence, citedTexts) === undefined ? 'no_claim_without_ground' : undefined;
    case 'supported':
      if (!hasEnoughWords(verdict.quote)) return 'quote_too_short';
      if (!citedTexts.some((text) => quoteIsIn(verdict.quote, text))) return 'quote_not_in_cited_passages';
      return isAbout(verdict.quote, sentence.text) ? undefined : 'quote_not_about_sentence';
  }
}

/** The verdict for a sentence whose checker verdict broke a rule: unsupported, because no passage was shown to state it. */
const setAside = (number: number, code: RuleCode): SentenceVerdict => ({
  number,
  verdict: 'unsupported',
  kind: 'not_stated',
  problem: RULE_PROBLEMS[code],
  code,
});

/**
 * The verdicts that count, from the verdicts the checker gave: each is judged on its own sentence. One that breaks a rule
 * (a quote that is too short, not in a cited passage or about something else; "no fact" where nothing shows it) becomes
 * unsupported for that sentence with its code, and the others stand. The reply is never refused whole for it (D-265).
 *
 * A reply in which more than half of the answer's sentences are marked "no fact" on the weakest ground (sharing no key word
 * with their passages, which is not a title, a question or an admission code can see) is not credible: those sentences
 * are set aside too.
 *
 * @param verdicts one for each sentence, in order (the shape is checked before this)
 * @param passageTexts the words of each passage by handle
 */
export function judgeVerdicts(
  verdicts: readonly SentenceVerdict[],
  sentences: readonly SentenceUnderCheck[],
  passageTexts: ReadonlyMap<string, string>,
): readonly SentenceVerdict[] {
  const citedTextsOf = (sentence: SentenceUnderCheck) =>
    sentence.cites.flatMap((handle) => passageTexts.get(handle) ?? []);
  const judged = verdicts.map((verdict, index) => {
    const sentence = sentences[index]!;
    const code = ruleBrokenBy(verdict, sentence, citedTextsOf(sentence));
    return code === undefined ? verdict : setAside(verdict.number, code);
  });
  const weakest = judged.flatMap((verdict, index) =>
    verdict.verdict === 'no_claim' && noClaimGround(sentences[index]!, citedTextsOf(sentences[index]!)) === 'unshared'
      ? [index]
      : [],
  );
  const stated = sentences.filter((sentence) => sentence.label !== true).length;
  if (weakest.length <= Math.floor(stated / 2)) return judged;
  return judged.map((verdict, index) =>
    weakest.includes(index) ? setAside(verdict.number, 'too_many_no_claim') : verdict,
  );
}

/** The most sentences one request to the checker carries. A long answer is checked in batches, so no reply is cut short. */
export const ASK_SUPPORT_BATCH_SENTENCES = 10;

/** The most batches one draft may need. An answer with more sentences than this holds is not checked (D-267). */
export const ASK_SUPPORT_MAX_BATCHES = 4;

/** The sentences split into runs of at most {@link ASK_SUPPORT_BATCH_SENTENCES}, in order. An empty answer has none. */
export function batchesOf(sentences: readonly SentenceUnderCheck[]): readonly (readonly SentenceUnderCheck[])[] {
  const batches: SentenceUnderCheck[][] = [];
  for (let start = 0; start < sentences.length; start += ASK_SUPPORT_BATCH_SENTENCES)
    batches.push(sentences.slice(start, start + ASK_SUPPORT_BATCH_SENTENCES));
  return batches;
}
