/**
 * The short answer card of a what-if (D-211, D-212): the rules that decide whether a model's answer may be
 * shown. Pure: no database, clock or model. The writer proposes an assumption line, one to three claims that each
 * cite passages the code offered, and the figures a source states. Code checks every one of those, then composes
 * what the thread sees. What the branch changes and keeps is never the writer's: the card shows the checked
 * premise as it is. The shapes and text limits of what the writer may send are `application/answer-schemas.ts`.
 */

/** One passage the writer may cite: a claim of the thread root's Scroll, under the handle it is shown as. */
export interface CardPassage {
  /** What the writer cites: `e1`, `e2`, … */
  readonly handle: string;
  /** The claim's own ID in the Scroll's provenance; this is what is stored. */
  readonly claimId: string;
  readonly text: string;
}

/** Fewer passages than this and no card is attempted: nothing could be cited, so no model is asked. */
export const MIN_CARD_PASSAGES = 2;
/** More than this are not offered. */
export const MAX_CARD_PASSAGES = 24;
/** A claim may not repeat this many words in a row of a passage it cites (the Scroll's copy check, D-013). */
export const COPY_RUN_WORDS = 9;

/** What the writer answers, once its structure is known good. */
export interface AnswerDraft {
  readonly assumption: string;
  readonly claims: readonly { readonly text: string; readonly cites: readonly string[] }[];
  readonly numbers: readonly {
    readonly label: string;
    readonly value: string;
    readonly cites: readonly string[];
  }[];
}

/** What a stored, checked card holds (`scenario-answer.v1`): citations are claim IDs of the Scroll's provenance. */
export interface StoredAnswer {
  readonly version: 'scenario-answer.v1';
  readonly assumption: string;
  readonly claims: readonly { readonly text: string; readonly claimIds: readonly string[] }[];
  readonly numbers: readonly {
    readonly label: string;
    readonly value: string;
    readonly claimIds: readonly string[];
  }[];
}

/** Why a draft is refused. Each one has a fixed hint for the writer's one repair. */
export type AnswerRefusal =
  | 'unknown_citation'
  | 'claim_number_unstated'
  | 'assumption_number_unfounded'
  | 'figure_label_has_digit'
  | 'figure_not_a_measure'
  | 'figure_unstated'
  | 'copied_passage'
  | 'not_marked_as_reasoning'
  | 'claims_repeat';

export const ANSWER_HINTS: Readonly<Record<AnswerRefusal, string>> = {
  unknown_citation:
    'Cite only the handles of the passages offered ([e1], [e2], …), written as e1, e2, and never invent one.',
  claim_number_unstated:
    'A digit may appear in a claim only where a passage that claim cites states that same number. Write every quantity that follows from the premise in words, such as "about eight times".',
  assumption_number_unfounded:
    'The assumption line may use a number only if the branch itself states it. Write other quantities in words.',
  figure_label_has_digit:
    'The label of a figure names what it measures in words, with no digit. The number goes in "value" only.',
  figure_not_a_measure:
    'The value of a figure is one number with its short unit, such as "2 m" or "200 milliseconds", and nothing else: no words around it and no second number.',
  figure_unstated:
    'The value of a figure must appear, written exactly so, in a passage it cites. Leave "numbers" empty when no passage gives a figure.',
  copied_passage:
    'Nine or more words in a row match a passage. Say that claim in your own words, with a different sentence structure.',
  not_marked_as_reasoning:
    'This is a thought experiment. Mark what follows from the premise as reasoning, with words such as "would", "could" or "likely", never as a settled fact.',
  claims_repeat: 'Two claims say the same thing. Each claim adds something different.',
};

export interface AnswerRefusalAt {
  readonly code: AnswerRefusal;
  readonly path: readonly (string | number)[];
}

const REASONING_MARKER = /\b(?:would|could|might|may|likely|probably|perhaps|suppose|if)\b/iu;

/**
 * A figure's value: one number and, at most, one short unit after it ("2 m", "200 milliseconds", "37%", "5 km²").
 * No prose around it, no second number, nothing a source did not write in just that form.
 */
const MEASURE = /^\d+(?:[.,]\d+)*(?: ?[^\s\d]{1,12})?$/u;

const squeezed = (text: string): string => text.normalize('NFKC').toLowerCase().replaceAll(/\s+/gu, ' ');

/**
 * Whether a passage writes `value` as it is: the same characters, with no letter or digit stuck to either end and
 * no more digits after it (`150` is not in `1500` or `150,000`).
 */
function writesValue(passage: string, value: string): boolean {
  const escaped = squeezed(value)
    .trim()
    .replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(String.raw`(?<![\p{L}\p{N}][.,]?)${escaped}(?![\p{L}\p{N}]|[.,]\p{N})`, 'u').test(
    squeezed(passage),
  );
}

/** Numeric tokens of a text as comparable strings: `4,096` and `4096` are the same figure. */
function figuresIn(text: string): string[] {
  return [...text.matchAll(/\p{N}+(?:[.,]\p{N}+)*/gu)].map((match) => match[0].replaceAll(',', ''));
}

/** The words the copy check compares: lower-case letters and digits only. */
const wordsOf = (text: string): string[] =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 0);

/** Whether `text` repeats `size` words in a row of any of the sources, compared as lower-case words without punctuation. */
function copiesARun(text: string, sources: readonly string[], size: number): boolean {
  const material = new Set<string>();
  for (const source of sources) {
    const words = wordsOf(source);
    for (let at = 0; at + size <= words.length; at += 1) material.add(words.slice(at, at + size).join(' '));
  }
  const words = wordsOf(text);
  for (let at = 0; at + size <= words.length; at += 1)
    if (material.has(words.slice(at, at + size).join(' '))) return true;
  return false;
}

const sameWords = (a: string, b: string): boolean =>
  a.normalize('NFKC').toLowerCase().replaceAll(/\W+/gu, ' ').trim() ===
  b.normalize('NFKC').toLowerCase().replaceAll(/\W+/gu, ' ').trim();

/**
 * The rules, in one pass. `premiseTexts` are the statements and the title the branch itself states (what changes,
 * what stays, what holds): the only figures the assumption line may use besides a passage's. Returns every
 * refusal with where it is; empty means the draft may be shown.
 */
export function answerRefusals(
  draft: AnswerDraft,
  passages: readonly CardPassage[],
  premiseTexts: readonly string[],
): readonly AnswerRefusalAt[] {
  const byHandle = new Map(passages.map((passage) => [passage.handle, passage]));
  const found: AnswerRefusalAt[] = [];
  const premiseFigures = new Set(premiseTexts.flatMap(figuresIn));

  const cited = (cites: readonly string[]): readonly CardPassage[] | undefined => {
    const resolved = cites.map((handle) => byHandle.get(handle));
    return resolved.every((passage) => passage !== undefined) ? resolved : undefined;
  };
  const stated = (cites: readonly CardPassage[]) => new Set(cites.flatMap((passage) => figuresIn(passage.text)));

  if (figuresIn(draft.assumption).some((figure) => !premiseFigures.has(figure)))
    found.push({ code: 'assumption_number_unfounded', path: ['assumption'] });

  draft.claims.forEach((claim, index) => {
    const sources = cited(claim.cites);
    if (sources === undefined) return void found.push({ code: 'unknown_citation', path: ['claims', index, 'cites'] });
    const allowed = stated(sources);
    // A figure the branch's own premise states is the premise's, not a claim about the world.
    if (figuresIn(claim.text).some((figure) => !allowed.has(figure) && !premiseFigures.has(figure)))
      found.push({ code: 'claim_number_unstated', path: ['claims', index, 'text'] });
    if (
      copiesARun(
        claim.text,
        sources.map((source) => source.text),
        COPY_RUN_WORDS,
      )
    )
      found.push({ code: 'copied_passage', path: ['claims', index, 'text'] });
  });

  draft.numbers.forEach((figure, index) => {
    const sources = cited(figure.cites);
    if (sources === undefined) return void found.push({ code: 'unknown_citation', path: ['numbers', index, 'cites'] });
    // A figure's label is words: a digit there would be a number no passage was asked to state.
    if (figuresIn(figure.label).length > 0)
      found.push({ code: 'figure_label_has_digit', path: ['numbers', index, 'label'] });
    const value = figure.value.trim();
    if (!MEASURE.test(value))
      return void found.push({ code: 'figure_not_a_measure', path: ['numbers', index, 'value'] });
    // The figure is a source's: the value as written, number and unit together, is in a passage the figure cites.
    if (!sources.some((source) => writesValue(source.text, value)))
      found.push({ code: 'figure_unstated', path: ['numbers', index, 'value'] });
  });

  if (!draft.claims.some((claim) => REASONING_MARKER.test(claim.text)))
    found.push({ code: 'not_marked_as_reasoning', path: ['claims'] });
  const texts = draft.claims.map((claim) => claim.text);
  if (texts.some((text, index) => texts.findIndex((other) => sameWords(other, text)) !== index))
    found.push({ code: 'claims_repeat', path: ['claims'] });
  return found;
}

/**
 * The checked card as it is stored: the same words, with each cited handle replaced by the claim's own ID in the
 * Scroll's provenance. Call it only with a draft `answerRefusals` found nothing in.
 */
export function storedAnswerOf(draft: AnswerDraft, passages: readonly CardPassage[]): StoredAnswer {
  const idOf = new Map(passages.map((passage) => [passage.handle, passage.claimId]));
  const idsOf = (cites: readonly string[]) => [...new Set(cites.map((handle) => idOf.get(handle) ?? ''))];
  return {
    version: 'scenario-answer.v1',
    assumption: draft.assumption,
    claims: draft.claims.map((claim) => ({ text: claim.text, claimIds: idsOf(claim.cites) })),
    numbers: draft.numbers.map((figure) => ({
      label: figure.label,
      value: figure.value,
      claimIds: idsOf(figure.cites),
    })),
  };
}

/** What the thread reads of a stored card: the assumption, the claims' words as one answer, and the figures. No citations. */
export function readableAnswerOf(stored: StoredAnswer) {
  return {
    assumption: stored.assumption,
    answer: stored.claims.map((claim) => claim.text).join(' '),
    numbers: stored.numbers.map(({ label, value }) => ({ label, value })),
  };
}
