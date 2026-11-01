/**
 * The rules of a Quick answer (D-253): what a model's draft must satisfy before a person may see it, and how long
 * the words are kept. Pure: no database, clock or model. The writer proposes a question, an answer, whether the
 * passages it was shown cover the question, and the passages the answer rests on. Code checks the draft's shape: that every
 * citation is an offered passage, that no digit is new, that the text is plain, that the question is about the words and
 * the passages. Code cannot see whether a sentence without a digit says what the passage says. That is the support check
 * (a second model, D-250, see `quick-answer-support.ts`), and it is a judgement, not a proof.
 */
/** A Quick answer lives a day. A day or more keeps the person's daily count exact, because it is counted from these rows. */
export const QUICK_ANSWER_RETENTION_HOURS = 24;
/** How many a person may have waiting at once; it bounds the jobs one person can queue. */
export const MAX_OPEN_QUICK_ANSWERS = 3;
/** The longest the question the card shows and the answer may be (the contract's limits). */
export const QUESTION_MAX_CHARS = 200;
export const ANSWER_MAX_CHARS = 640;
/**
 * The most paid model attempts one delivery of the answering job may make: the writer's answer (and the harness's one repair of
 * an invalid reply), the support check of it (and its repair), the one rewrite an unsupported sentence earns (no repair of its
 * own), and the check of the rewrite (no repair of its own): 2 + 2 + 1 + 1. The job's claim (`answerQuickAnswerQueue`) is
 * sized from it, so a delivery that is still waiting on the provider is never expired from under itself, and the daily caps
 * bound the spend at this many paid attempts for each Quick answer at the most.
 */
export const MAX_PAID_ATTEMPTS = 6;
/**
 * What a card says when what the person has read does not answer their question. The sentence is code's, never the model's: a
 * card that says "not covered" shows no model text, so nothing in it can be outside knowledge.
 */
export const NOT_COVERED_ANSWER = 'What you have read so far does not answer that. A full Scroll would.';
/** The question line of such a card when the person typed none: their own selected words, cut short to this many characters. */
export const NOT_COVERED_QUESTION_CHARS = 80;
/** An answer rests on this many passages at most. */
export const MAX_CITATIONS = 3;

const UTC_DAY_MS = 86_400_000;

/** The start of the UTC day the caps count from. */
export function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / UTC_DAY_MS) * UTC_DAY_MS);
}

/** When an answer asked at `asked` is erased. */
export function expiryOf(asked: Date): Date {
  return new Date(asked.getTime() + QUICK_ANSWER_RETENTION_HOURS * 3_600_000);
}

/** One passage the writer may cite: a read stop of the Scroll up to the reader's, under the handle it is shown as. */
export interface CitablePassage {
  /** What the writer cites: `e1`, `e2`, … */
  readonly handle: string;
  readonly stopId: string;
  readonly text: string;
}

/** What the writer proposes, once its structure is known good. */
export interface QuickAnswerDraft {
  /** The question the answer addresses: the person's own, or the one a reader of those words most likely has. */
  readonly question: string;
  readonly answer: string;
  /** False when the passages do not say enough to answer: `answer` then says so plainly. */
  readonly covered: boolean;
  readonly cites: readonly string[];
}

/** Why a draft is refused. Each has a fixed hint for the writer's one repair. */
export type QuickAnswerRefusal =
  | 'unknown_citation'
  | 'covered_without_citation'
  | 'citation_without_cover'
  | 'figure_unstated'
  | 'not_plain_text'
  | 'question_off_topic';

export const QUICK_ANSWER_HINTS: Readonly<Record<QuickAnswerRefusal, string>> = {
  unknown_citation:
    'Cite only the handles of the passages offered ([e1], [e2], …), written as e1, e2, and never invent one.',
  covered_without_citation:
    'An answer that the passages cover cites one to three of them. Cite the passages it rests on.',
  citation_without_cover:
    'When the passages do not cover the question, set "covered" to false, cite nothing, and say plainly that what has been read so far does not say.',
  figure_unstated:
    'A digit may appear only where a passage you cite, the selected words or the question states that same number. Write other quantities in words.',
  not_plain_text: 'Use plain sentences: no Markdown, no lists, no line breaks, no web addresses and no angle brackets.',
  question_off_topic:
    'The question must be about the selected words and the passages you cite, in their own words. Restate the question the reader typed, or the one the selected words raise.',
};

export interface QuickAnswerRefusalAt {
  readonly code: QuickAnswerRefusal;
  readonly path: readonly (string | number)[];
}

const MARKUP = /[*#`<>[\]{}|_~\\]|https?:|www\./iu;

/** Whether a text is one run of plain sentences. */
function isPlain(text: string): boolean {
  return !MARKUP.test(text) && !/[\p{Cc}\p{Cf}]/u.test(text);
}

/** Numeric tokens of a text as comparable strings: `4,096` and `4096` are the same figure. */
function figuresIn(text: string): string[] {
  return [...text.matchAll(/\p{N}+(?:[.,]\p{N}+)*/gu)].map((match) => match[0].replaceAll(',', ''));
}

/** What a draft may state besides the passages it cites: the words the person selected and the question they typed. */
export interface QuickAnswerAsk {
  readonly passage: string;
  readonly question: string | undefined;
}

/**
 * The rules, in one pass. Returns every refusal with where it is; empty means the draft's shape may go on to the support
 * check. A draft that says the passages do not cover the question cites nothing and its words are never shown (the card says
 * `NOT_COVERED_ANSWER`), so only its citations are checked. Otherwise: every citation is an offered passage, the answer's and
 * the question's figures come only from what it cites, the person's selected words or their own question (nothing is a number
 * the Scroll did not state), and both are plain text. That the question is about the selected words and the cited passages
 * compares key words, which is the support check's own helper (the role applies it, `question_off_topic`). Whether each sentence
 * says what its passages say is not a rule code can check: the support check judges it.
 */
export function quickAnswerRefusals(
  draft: QuickAnswerDraft,
  passages: readonly CitablePassage[],
  ask: QuickAnswerAsk,
): readonly QuickAnswerRefusalAt[] {
  const found: QuickAnswerRefusalAt[] = [];
  const byHandle = new Map(passages.map((passage) => [passage.handle, passage]));
  const cited = draft.cites.map((handle) => byHandle.get(handle));
  if (cited.some((passage) => passage === undefined)) found.push({ code: 'unknown_citation', path: ['cites'] });
  if (draft.covered && draft.cites.length === 0) found.push({ code: 'covered_without_citation', path: ['cites'] });
  if (!draft.covered) {
    if (draft.cites.length > 0) found.push({ code: 'citation_without_cover', path: ['cites'] });
    return found;
  }
  if (!isPlain(draft.answer)) found.push({ code: 'not_plain_text', path: ['answer'] });
  if (!isPlain(draft.question)) found.push({ code: 'not_plain_text', path: ['question'] });
  const citedTexts = cited.flatMap((passage) => (passage === undefined ? [] : [passage.text]));
  const stated = new Set([...citedTexts, ask.passage, ask.question ?? ''].flatMap(figuresIn));
  if (figuresIn(draft.answer).some((figure) => !stated.has(figure)))
    found.push({ code: 'figure_unstated', path: ['answer'] });
  if (figuresIn(draft.question).some((figure) => !stated.has(figure)))
    found.push({ code: 'figure_unstated', path: ['question'] });
  return found;
}

/** What a card shows. */
export interface ShownAnswer {
  readonly question: string;
  readonly answer: string;
  readonly covered: boolean;
}

/**
 * What the card shows of a draft: the model's question and answer for a covered one, and for one the passages do not cover
 * the person's own question (or their selected words, cut short) with the sentence code owns. No model text reaches a card
 * that says it cannot answer.
 */
export function shownOf(draft: QuickAnswerDraft, ask: QuickAnswerAsk): ShownAnswer {
  if (draft.covered) return { question: draft.question, answer: draft.answer, covered: true };
  const words = ask.passage.replaceAll(/\s+/gu, ' ').trim();
  const cut = words.length > NOT_COVERED_QUESTION_CHARS ? `${words.slice(0, NOT_COVERED_QUESTION_CHARS - 1)}…` : words;
  return { question: ask.question ?? `About “${cut}”`, answer: NOT_COVERED_ANSWER, covered: false };
}

/** The handle a passage is shown to the writer as. */
export const handleOf = (index: number): string => `e${String(index + 1)}`;

/**
 * Whether the words the person selected are from the stop they say they are in. A page may hand over its text with other
 * spacing than the stored one, so the two are compared as lower-case words with the spaces squeezed.
 */
export function isFromStop(passage: string, stopText: string): boolean {
  const squeeze = (text: string): string => text.normalize('NFKC').toLowerCase().replaceAll(/\s+/gu, ' ').trim();
  const wanted = squeeze(passage);
  return wanted.length > 0 && squeeze(stopText).includes(wanted);
}
