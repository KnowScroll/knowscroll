/**
 * #162 — the pure Scroll-writing boundary (ADR-0041 §3–§5). Three steps, no I/O:
 *
 * `serializeScrollWritingRequest` turns the offered concepts and the fetched material into the exact
 * request bytes, trimming the material at a word so the whole request stays within the bound.
 *
 * `parseScrollReply` accepts exactly one JSON object of the reply's shape, or names the shape rule
 * the reply broke.
 *
 * `checkScrollDraft` decides, deterministically, whether a draft may become a Scroll: every quote
 * is an exact passage of the stored material, the prose copies no passage of it, the shape is
 * bounded, and the concepts are the substrate's own. Provider text carries no authority of its own.
 * A quote it refuses is diagnosed with a code that carries no text (`quote-diagnosis-v1`).
 */
import { z } from 'zod';
import { claimConceptRole, conceptCode } from '../../../contracts/src/semantic.ts';
import { canonical, wholeObject } from '../reasoning/wire.ts';
import { normalizeSnapshotText } from '../semantic/source-text.ts';

export const SCROLL_WRITING_VERSIONS = Object.freeze({
  prompt: 'scroll-writing-prompt-v1', reply: 'scroll-reply-v1', checks: 'scroll-checks-v2', quoteDiagnosis: 'quote-diagnosis-v1',
});
/** Bench values (ADR-0041 §3, §5): a changed number is a new checks version. Ranges are inclusive. */
export const SCROLL_LIMITS = Object.freeze({
  requestBytes: 16_384, maxOutputTokens: 4_096, offeredConcepts: 8,
  titleChars: [8, 90], summaryChars: [20, 240], beats: [3, 7], beatChars: [40, 700], claims: [2, 6],
  statementChars: [12, 400], quoteChars: [12, 400],
  /** A run of more consecutive words than this, shared with the material, is a copied passage. */
  maxSharedWords: 8,
} as const);

export interface OfferedConcept { code: string; name: string; description: string }
export interface ScrollRoute { model: string; maxOutputTokens: number }

/** One line of an operator's plan: a page and the existing concepts its Scroll is about. */
export const scrollPlanItem = z.object({
  url: z.string().min(1).max(2000),
  conceptCodes: z.array(conceptCode).min(1).max(SCROLL_LIMITS.offeredConcepts),
}).strict().refine(item => new Set(item.conceptCodes).size === item.conceptCodes.length, 'concept codes must be distinct');
export type ScrollPlanItem = z.infer<typeof scrollPlanItem>;

const SYSTEM = [
  'You write one Scroll: a short, vivid explanation for a curious reader, in your own words, built only from the material provided.',
  'Reply with exactly one JSON object and nothing else:',
  '{"title": string, "summary": string, "beats": [string], "concepts": [{"code": string, "role": "primary" | "secondary"}],',
  ' "claims": [{"statement": string, "truthState": "documented", "concepts": [{"code": string, "role": "subject" | "object" | "mechanism" | "context"}], "quote": string, "supportKind": "supports" | "qualifies"}]}.',
  'Title: 8 to 90 characters. Summary: one sentence, 20 to 240 characters.',
  'Beats: 3 to 7 short paragraphs, each 40 to 700 characters, that tell the idea in order.',
  'Write the title, summary and beats in your own words: never repeat more than a few words in a row from the material.',
  'Concepts: only codes from the offered concepts, exactly one of them "primary" (what the Scroll is about).',
  'Claims: 2 to 6 facts the Scroll relies on. Each has a plain statement (12 to 400 characters), names at least one offered concept,',
  ' and has a quote copied word for word from the material (12 to 400 characters) that supports it ("supports") or limits it ("qualifies").',
  'Do not mention the material, a publisher, a website or a web address. Do not describe or guess anything about the reader.',
].join('\n');

export const OFFERED_CONCEPTS_MARKER = 'Offered concepts (JSON):';
export const MATERIAL_MARKER = 'Material (the visible text of one public-domain page):';

/** The exact request bytes, with the longest word-boundary prefix of `material` that keeps the whole
 * request within `SCROLL_LIMITS.requestBytes`. */
export function serializeScrollWritingRequest(input: { material: string; concepts: readonly OfferedConcept[] }, route: ScrollRoute): { body: Uint8Array; materialChars: number } {
  const concepts = canonical(input.concepts.map(c => ({ code: c.code, name: c.name, description: c.description })));
  const bytes = (material: string) => new TextEncoder().encode(canonical({
    model: route.model,
    max_tokens: route.maxOutputTokens,
    // One JSON reply; hidden reasoning would spend the bounded output budget.
    thinking: { type: 'disabled' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${OFFERED_CONCEPTS_MARKER}\n${concepts}\n\n${MATERIAL_MARKER}\n${material}` }],
  }));
  const whole = bytes(input.material);
  if (whole.length <= SCROLL_LIMITS.requestBytes) return { body: whole, materialChars: input.material.length };
  // The largest prefix that fits, then back to the last word boundary inside it.
  let fits = 0, over = input.material.length;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (bytes(input.material.slice(0, mid)).length <= SCROLL_LIMITS.requestBytes) fits = mid; else over = mid;
  }
  const materialChars = Math.max(0, input.material.lastIndexOf(' ', fits));
  return { body: bytes(input.material.slice(0, materialChars)), materialChars };
}

const text = z.string().refine(v => !v.includes('\0'));
const replySchema = z.object({
  title: text,
  summary: text,
  beats: z.array(text),
  concepts: z.array(z.object({ code: z.string(), role: z.enum(['primary', 'secondary']) }).strict()).min(1).max(SCROLL_LIMITS.offeredConcepts),
  claims: z.array(z.object({
    statement: text,
    truthState: z.literal('documented'),
    concepts: z.array(z.object({ code: z.string(), role: claimConceptRole }).strict()).min(1).max(6),
    quote: text,
    supportKind: z.enum(['supports', 'qualifies']),
  }).strict()),
}).strict();
export type ScrollDraft = z.infer<typeof replySchema>;

export type ScrollShapeReason = 'not_one_json_object' | 'reply_keys' | 'shape_invalid';
const REPLY_KEYS = ['beats', 'claims', 'concepts', 'summary', 'title'];

export function parseScrollReply(text: string): { kind: 'draft'; draft: ScrollDraft } | { kind: 'shape'; reason: ScrollShapeReason } {
  const value = wholeObject(text);
  if (!value) return { kind: 'shape', reason: 'not_one_json_object' };
  if (Object.keys(value).sort().join(',') !== REPLY_KEYS.join(',')) return { kind: 'shape', reason: 'reply_keys' };
  const parsed = replySchema.safeParse(value);
  return parsed.success ? { kind: 'draft', draft: parsed.data } : { kind: 'shape', reason: 'shape_invalid' };
}

/** A URL, `www.`, or a bare domain on a public suffix a source could live under. */
const WEB_ADDRESS = /https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:gov|org|com|edu|net|mil|int|io|us)\b/i;

/** scroll-checks-v2's closed vocabulary, in the order a refusal lists them. */
const CHECK_ORDER = [
  'quote_not_in_material', 'copied_passage', 'mentions_web_address',
  'title_length', 'summary_length', 'beat_count', 'beat_length', 'claim_count', 'statement_length', 'quote_length',
  'concept_unknown', 'concept_not_offered', 'primary_not_one', 'duplicate_concept', 'claim_concept_not_offered', 'no_supporting_claim',
] as const;
export type ScrollCheckReason = typeof CHECK_ORDER[number];

export interface CheckedScroll {
  title: string; summary: string; beats: string[];
  /** The beats joined by blank lines: the readers render each as a paragraph. */
  body: string;
  concepts: ScrollDraft['concepts'];
  /** `quote` is normalized, so it is an exact passage of the stored material. */
  claims: { statement: string; concepts: ScrollDraft['claims'][number]['concepts']; quote: string; supportKind: 'supports' | 'qualifies' }[];
}
export interface ScrollCheckContext {
  /** The stored material: the normalized visible text of the whole page. */
  material: string;
  offered: readonly string[];
  /** Every concept code in the substrate. */
  known: ReadonlySet<string>;
}
export type ScrollVerdict =
  | { ok: true; scroll: CheckedScroll; checksVersion: string }
  | {
    ok: false; reasons: (ScrollShapeReason | ScrollCheckReason)[]; checksVersion: string;
    /** With `quote_not_in_material` only: one per quote that is not a passage of the material, in claim order. */
    quoteDiagnoses?: QuoteDiagnosis[];
  };

/** Case-folded words; punctuation (hyphens included) separates, apostrophes belong to a word. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'").split(/[^\p{L}\p{N}']+/u)
    .map(w => w.replace(/^'+|'+$/g, '')).filter(w => w.length > 0);
}
function runs(list: readonly string[], length: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + length <= list.length; i += 1) out.push(list.slice(i, i + length).join(' '));
  return out;
}
/**
 * quote-diagnosis-v1 (#181): what separates a refused quote from the material, the first that holds.
 * It is a passage once typography is folded (curly quotes and apostrophes, dashes and the ellipsis to
 * ASCII, on both sides); once case is folded too; its words are a run of the material's (punctuation
 * and sentence breaks aside); at least half its words are; or none of these. A diagnosis is a code that
 * carries no text, and never changes a verdict.
 */
export type QuoteDiagnosis = 'quote:typography' | 'quote:case' | 'quote:words' | 'quote:partial' | 'quote:absent';
const TYPOGRAPHY: readonly [RegExp, string][] = [[/[‘’‚‛′ʼ]/g, "'"], [/[“”„‟″]/g, '"'], [/[‐‑‒–—―−]/g, '-'], [/…/g, '...']];
const foldTypography = (text: string) => TYPOGRAPHY.reduce((out, [from, to]) => out.replace(from, to), text);

function diagnoseQuotes(quotes: readonly string[], material: string): QuoteDiagnosis[] {
  const folded = foldTypography(material);
  const foldedCase = folded.toLowerCase();
  const materialWords = ` ${words(material).join(' ')} `;
  const inMaterial = (run: string) => run.length > 0 && materialWords.includes(` ${run} `);
  return quotes.map(quote => {
    const q = foldTypography(quote);
    if (folded.includes(q)) return 'quote:typography';
    if (foldedCase.includes(q.toLowerCase())) return 'quote:case';
    const list = words(quote);
    if (inMaterial(list.join(' '))) return 'quote:words';
    return runs(list, Math.ceil(list.length / 2)).some(inMaterial) ? 'quote:partial' : 'quote:absent';
  });
}

/** Code points, as PostgreSQL's length() counts them. */
const chars = (value: string) => Array.from(value).length;
const within = (value: number, [min, max]: readonly [number, number]) => value >= min && value <= max;

export function checkScrollDraft(draft: ScrollDraft, context: ScrollCheckContext): ScrollVerdict {
  const checksVersion = SCROLL_WRITING_VERSIONS.checks;
  const L = SCROLL_LIMITS;
  const title = normalizeSnapshotText(draft.title);
  const summary = normalizeSnapshotText(draft.summary);
  const beats = draft.beats.map(normalizeSnapshotText);
  const claims = draft.claims.map(c => ({ statement: normalizeSnapshotText(c.statement), concepts: c.concepts, quote: normalizeSnapshotText(c.quote), supportKind: c.supportKind }));
  const found = new Set<ScrollCheckReason>();

  const refusedQuotes = claims.map(c => c.quote).filter(quote => !context.material.includes(quote));
  if (refusedQuotes.length > 0) found.add('quote_not_in_material');
  const copied = new Set(runs(words(context.material), L.maxSharedWords + 1));
  const prose = [title, summary, ...beats];
  if (prose.some(part => runs(words(part), L.maxSharedWords + 1).some(run => copied.has(run)))) found.add('copied_passage');
  // v2 (review of #178): a bare domain names a source as surely as a URL, and claim statements reach
  // readers as evidence, so both are checked.
  if ([...prose, ...claims.map(c => c.statement)].some(part => WEB_ADDRESS.test(part))) found.add('mentions_web_address');

  if (!within(chars(title), L.titleChars)) found.add('title_length');
  if (!within(chars(summary), L.summaryChars)) found.add('summary_length');
  if (!within(beats.length, L.beats)) found.add('beat_count');
  if (beats.some(b => !within(chars(b), L.beatChars))) found.add('beat_length');
  if (!within(claims.length, L.claims)) found.add('claim_count');
  if (claims.some(c => !within(chars(c.statement), L.statementChars))) found.add('statement_length');
  if (claims.some(c => !within(chars(c.quote), L.quoteChars))) found.add('quote_length');

  const offered = new Set(context.offered);
  const allCodes = [...draft.concepts.map(c => c.code), ...claims.flatMap(c => c.concepts.map(l => l.code))];
  if (allCodes.some(code => !context.known.has(code))) found.add('concept_unknown');
  if (draft.concepts.some(c => !offered.has(c.code))) found.add('concept_not_offered');
  if (draft.concepts.filter(c => c.role === 'primary').length !== 1) found.add('primary_not_one');
  const distinct = (keys: string[]) => new Set(keys).size === keys.length;
  if (!distinct(draft.concepts.map(c => c.code)) || claims.some(c => !distinct(c.concepts.map(l => `${l.code}:${l.role}`)))) found.add('duplicate_concept');
  if (claims.some(c => !c.concepts.some(l => offered.has(l.code)))) found.add('claim_concept_not_offered');
  if (!claims.some(c => c.supportKind === 'supports')) found.add('no_supporting_claim');

  if (found.size > 0) {
    const diagnosed = refusedQuotes.length > 0 ? { quoteDiagnoses: diagnoseQuotes(refusedQuotes, context.material) } : {};
    return { ok: false, reasons: CHECK_ORDER.filter(r => found.has(r)), checksVersion, ...diagnosed };
  }
  return { ok: true, scroll: { title, summary, beats, body: beats.join('\n\n'), concepts: draft.concepts, claims }, checksVersion };
}

/** A reply, parsed and then checked: the one verdict admission acts on. */
export function judgeScrollReply(text: string, context: ScrollCheckContext): ScrollVerdict {
  const reply = parseScrollReply(text);
  if (reply.kind === 'shape') return { ok: false, reasons: [reply.reason], checksVersion: SCROLL_WRITING_VERSIONS.checks };
  return checkScrollDraft(reply.draft, context);
}
