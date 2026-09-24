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

export const ASK_ANSWER_VERSIONS = Object.freeze({ prompt: 'ask-answer-prompt-v1', validator: 'ask-answer-v1' });
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
  | 'limits_missing' | 'characterizes_reader';
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

/** Stable key order, so equal inputs give equal bytes and therefore an equal reserved hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  }));
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
// Statements about the reader, not the subject: the product never characterises a person.
const CHARACTERIZES = /\b(you (seem|are|must be|clearly|probably|love|like|prefer|enjoy)|your (personality|interests?|nature|kind of person))\b/i;

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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject('shape_invalid');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'answer,basis,limits') return reject('shape_invalid');
  if (!(v.answer === null || typeof v.answer === 'string') || typeof v.limits !== 'string' || !Array.isArray(v.basis)) return reject('shape_invalid');
  if (v.basis.length > ASK_ANSWER_LIMITS.maxQuotes) return reject('shape_invalid');
  const basis: { quote: string }[] = [];
  for (const item of v.basis) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).join(',') !== 'quote' || typeof (item as { quote: unknown }).quote !== 'string') return reject('shape_invalid');
    basis.push({ quote: (item as { quote: string }).quote });
  }
  const limits = v.limits.trim();
  if (limits.length > ASK_ANSWER_LIMITS.limitsChars) return reject('shape_invalid');

  if (v.answer === null) {
    if (limits.length === 0) return reject('limits_missing');
    if (CHARACTERIZES.test(limits)) return reject('characterizes_reader');
    return { ok: true, proposal: { kind: 'not_in_source', limits }, validatorVersion };
  }
  const answer = v.answer.trim();
  const reasons: AskAnswerRejection[] = [];
  if (answer.length === 0) return reject('shape_invalid');
  if (answer.length > ASK_ANSWER_LIMITS.answerChars) reasons.push('answer_too_long');
  if (basis.length === 0) reasons.push('basis_missing');
  const haystack = squash(`${source.scroll.summary}\n${source.scroll.body}`);
  if (basis.some(b => b.quote.length < ASK_ANSWER_LIMITS.quoteMinChars || b.quote.length > ASK_ANSWER_LIMITS.quoteMaxChars || !haystack.includes(squash(b.quote)))) reasons.push('basis_not_in_source');
  if (CHARACTERIZES.test(answer) || CHARACTERIZES.test(limits)) reasons.push('characterizes_reader');
  if (reasons.length > 0) return reject(...reasons);
  return { ok: true, proposal: { kind: 'answered', answer, basis: basis.map(b => ({ quote: squash(b.quote) })), limits }, validatorVersion };
}
