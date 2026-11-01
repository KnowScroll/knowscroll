/**
 * The rules of a Quick answer (D-253): what a model's draft must satisfy before a person may see it, and how long
 * the words are kept. Pure: no database, clock or model. The writer proposes a question, an answer, whether the
 * passages it was shown cover the question, and the passages the answer rests on. Code checks every one of them.
 */

/** A Quick answer lives a day. A day or more keeps the person's daily count exact, because it is counted from these rows. */
export const QUICK_ANSWER_RETENTION_HOURS = 24;
/** How many a person may have waiting at once; it bounds the jobs one person can queue. */
export const MAX_OPEN_QUICK_ANSWERS = 3;
/** The longest the question the card shows and the answer may be (the contract's limits). */
export const QUESTION_MAX_CHARS = 200;
export const ANSWER_MAX_CHARS = 640;
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
  'unknown_citation' | 'covered_without_citation' | 'citation_without_cover' | 'figure_unstated' | 'not_plain_text';

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
 * The rules, in one pass. Returns every refusal with where it is; empty means the draft may be shown.
 * The answer's figures come only from what it cites, the person's selected words or their own question: nothing in
 * a Quick answer is a number the Scroll did not state.
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
  if (!draft.covered && draft.cites.length > 0) found.push({ code: 'citation_without_cover', path: ['cites'] });
  if (!isPlain(draft.answer)) found.push({ code: 'not_plain_text', path: ['answer'] });
  if (!isPlain(draft.question)) found.push({ code: 'not_plain_text', path: ['question'] });
  const stated = new Set(
    [
      ...cited.flatMap((passage) => (passage === undefined ? [] : [passage.text])),
      ask.passage,
      ask.question ?? '',
    ].flatMap(figuresIn),
  );
  if (figuresIn(draft.answer).some((figure) => !stated.has(figure)))
    found.push({ code: 'figure_unstated', path: ['answer'] });
  if (figuresIn(draft.question).some((figure) => !stated.has(figure)))
    found.push({ code: 'figure_unstated', path: ['question'] });
  return found;
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
