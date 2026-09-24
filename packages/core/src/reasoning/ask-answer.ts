/**
 * #132 — the pure Ask-answer boundary (ADR-0033). Two functions, no I/O:
 *
 * `serializeAskAnswerRequest` turns the sealed literal question and the complete Scroll it was asked
 * on into the exact request bytes. Admission reserves their hash; the worker rebuilds the same
 * bytes from the same sealed context, so what is sent is what was authorized.
 *
 * `validateAskAnswerProposal` decides whether provider text may become an answer. Provider content
 * has no mutation authority (ADR-0012): only a proposal whose every basis quote is found in the
 * Scroll, whose shape is exact and bounded, and which does not characterise the reader is applied.
 * "The Scroll does not say" is a valid, honest outcome.
 */

import { canonical } from './wire.ts';

// v2 (2026-09-24): basis items are projected to their quote (see the loop below). Measured live:
// five of five replies to a yes/no question failed v1's exact item shape, with verbatim-checkable quotes.
export const ASK_ANSWER_VERSIONS = Object.freeze({ prompt: 'ask-answer-prompt-v1', validator: 'ask-answer-v2' });
export const ASK_ANSWER_LIMITS = Object.freeze({ answerChars: 1200, limitsChars: 400, quoteMinChars: 12, quoteMaxChars: 400, maxQuotes: 4 });

export interface AskAnswerSource {
  /** Exactly as the reader wrote it: never trimmed or normalised. */
  question: string;
  scroll: { title: string; summary: string; body: string; sourceTitle: string; sourceUrl: string; truthState: string };
}
export interface AskAnswerRoute { model: string; maxOutputTokens: number }

export type AskAnswerProposal =
  | { kind: 'answered'; answer: string; basis: { quote: string }[]; limits: string }
  | { kind: 'not_in_source'; limits: string };
export type AskAnswerRejection =
  | 'not_one_json_object' | 'shape_invalid' | 'basis_missing' | 'basis_not_in_source' | 'answer_too_long'
  | 'limits_missing' | 'characterizes_reader'
  // Which shape rule failed, always alongside 'shape_invalid': diagnostics only, never content.
  | 'shape_not_object' | 'shape_keys' | 'shape_types' | 'shape_too_many_quotes' | 'shape_basis_item' | 'shape_limits_too_long' | 'shape_empty_answer';
export type AskAnswerVerdict =
  | { ok: true; proposal: AskAnswerProposal; validatorVersion: string }
  | { ok: false; reasons: AskAnswerRejection[]; validatorVersion: string };

const SYSTEM = [
  'You answer one reader\'s question using only the Scroll provided.',
  'Reply with exactly one JSON object and nothing else:',
  '{"answer": string or null, "basis": [{"quote": string}], "limits": string}.',
  'Each basis quote must be copied word for word from the Scroll (12 to 400 characters, at most 4 quotes).',
  'If the Scroll does not answer the question, reply {"answer": null, "basis": [], "limits": "<what the Scroll does not cover>"}.',
  'Say where the answer stops in "limits". Do not describe or guess anything about the reader.',
].join('\n');

export function serializeAskAnswerRequest(source: AskAnswerSource, route: AskAnswerRoute): Uint8Array {
  const s = source.scroll;
  const content = [
    `Question (verbatim, JSON-encoded): ${JSON.stringify(source.question)}`,
    '',
    `Scroll title: ${s.title}`,
    `Truth state: ${s.truthState}`,
    `Source: ${s.sourceTitle} <${s.sourceUrl}>`,
    `Summary: ${s.summary}`,
    'Body:',
    s.body,
  ].join('\n');
  return new TextEncoder().encode(canonical({
    model: route.model,
    max_tokens: route.maxOutputTokens,
    // A short JSON reply needs no hidden reasoning, which would otherwise spend the output budget.
    thinking: { type: 'disabled' },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  }));
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
// Statements about the reader, not the subject: the product never characterises a person. After
// "you are / you're" only words about where the reader is or what they are doing pass ("near",
// "standing"…); any trait or taste ("you're curious", "you seem…", "you love…", "your curiosity") is
// refused unless it sits in a hypothetical clause of the same sentence ("if you are a sailor",
// "whichever unit you prefer"). Third-person description ("Darwin was the sort who…") is not about
// the reader. Curly apostrophes are normalised first.
const SITUATION = new Set(['near', 'in', 'at', 'on', 'by', 'from', 'inside', 'outside', 'under', 'above', 'below', 'here', 'there', 'standing',
  'looking', 'reading', 'walking', 'holding', 'using', 'watching', 'sailing', 'swimming', 'facing', 'measuring', 'counting', 'comparing', 'asking',
  'trying', 'going', 'able', 'told', 'shown', 'asked', 'given', 'free', 'welcome', 'not', 'likely']);
const HYPOTHETICAL = /\b(?:if|when|whenever|whether|whichever|whatever|however|once|suppose|supposing|imagine|unless|as long as)\b[^.!?;]*$/;
const TRAITS = [
  /\byou(?: are|'re)\s+([a-z]+)/g,
  /\byou (?:seem|must be|sound|strike me)\b/g,
  /\byou(?: clearly| obviously| probably| really)? (?:love|like|prefer|enjoy|adore)\b/g,
  /\byour (?:personality|interests?|nature|curiosity|character|taste|tastes|passion|kind of person)\b/g,
];
const normalize = (text: string) => text.replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase().replace(/\s+/g, ' ');
/** `scroll` is the Scroll's own text: a phrase it addresses to its reader, repeated word for word,
 * is the source speaking, not the model characterising the person reading. */
function characterizes(text: string, scroll = ''): boolean {
  const t = normalize(text);
  const own = normalize(scroll);
  for (const pattern of TRAITS) {
    for (const m of t.matchAll(pattern)) {
      if (m[1] !== undefined && SITUATION.has(m[1])) continue;
      if (HYPOTHETICAL.test(t.slice(0, m.index))) continue;
      // The matched words plus the next two, within the sentence: specific enough to be the Scroll's own.
      const phrase = t.slice(m.index).split(/[.!?;,]/)[0]!.split(' ').slice(0, m[0].split(' ').length + 2).join(' ');
      if (own.includes(phrase)) continue;
      return true;
    }
  }
  return false;
}
// Text the database would refuse is refused here, so a paid reply is never lost at storage.
const hasNul = (text: string) => text.includes('\u0000');

/** The single top-level JSON object in the text, after dropping reasoning blocks; null if none or several. */
function oneObject(text: string): unknown {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const objects: string[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i]!;
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = depth > 0; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}' && depth > 0) { depth -= 1; if (depth === 0) objects.push(stripped.slice(start, i + 1)); }
  }
  if (objects.length !== 1) return undefined;
  try { return JSON.parse(objects[0]!); } catch { return undefined; }
}

export function validateAskAnswerProposal(text: string, source: AskAnswerSource): AskAnswerVerdict {
  const validatorVersion = ASK_ANSWER_VERSIONS.validator;
  const reject = (...reasons: AskAnswerRejection[]): AskAnswerVerdict => ({ ok: false, reasons, validatorVersion });
  const value = oneObject(text);
  if (value === undefined) return reject('not_one_json_object');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject('shape_invalid', 'shape_not_object');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'answer,basis,limits') return reject('shape_invalid', 'shape_keys');
  if (!(v.answer === null || typeof v.answer === 'string') || typeof v.limits !== 'string' || !Array.isArray(v.basis)) return reject('shape_invalid', 'shape_types');
  if ((typeof v.answer === 'string' && hasNul(v.answer)) || hasNul(v.limits)) return reject('shape_invalid', 'shape_types');
  if (v.basis.length > ASK_ANSWER_LIMITS.maxQuotes) return reject('shape_invalid', 'shape_too_many_quotes');
  const basis: { quote: string }[] = [];
  for (const item of v.basis) {
    // v2: a quote may come as a bare string or as an object whose `quote` is a string. Any other
    // key on the item is dropped unread and never stored: only the quote carries weight, and it is
    // still checked word for word against the Scroll below.
    const quote = typeof item === 'string' ? item
      : item !== null && typeof item === 'object' && !Array.isArray(item) && typeof (item as { quote?: unknown }).quote === 'string' ? (item as { quote: string }).quote
      : null;
    if (quote === null || hasNul(quote)) return reject('shape_invalid', 'shape_basis_item');
    // Collapsed first: the length bounds, the Scroll check and the stored quote all see the same text.
    basis.push({ quote: squash(quote) });
  }
  const limits = v.limits.trim();
  if (limits.length > ASK_ANSWER_LIMITS.limitsChars) return reject('shape_invalid', 'shape_limits_too_long');

  if (v.answer === null) {
    if (limits.length === 0) return reject('limits_missing');
    if (characterizes(limits)) return reject('characterizes_reader');
    return { ok: true, proposal: { kind: 'not_in_source', limits }, validatorVersion };
  }
  const answer = v.answer.trim();
  const reasons: AskAnswerRejection[] = [];
  if (answer.length === 0) return reject('shape_invalid', 'shape_empty_answer');
  if (limits.length === 0) return reject('limits_missing');
  if (answer.length > ASK_ANSWER_LIMITS.answerChars) reasons.push('answer_too_long');
  if (basis.length === 0) reasons.push('basis_missing');
  const haystack = squash(`${source.scroll.summary}\n${source.scroll.body}`);
  if (basis.some(b => b.quote.length < ASK_ANSWER_LIMITS.quoteMinChars || b.quote.length > ASK_ANSWER_LIMITS.quoteMaxChars || !haystack.includes(b.quote))) reasons.push('basis_not_in_source');
  if (characterizes(answer, `${source.scroll.summary}\n${source.scroll.body}`) || characterizes(limits)) reasons.push('characterizes_reader');
  if (reasons.length > 0) return reject(...reasons);
  return { ok: true, proposal: { kind: 'answered', answer, basis, limits }, validatorVersion };
}
