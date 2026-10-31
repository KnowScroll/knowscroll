import { z } from 'zod';
import { splitSentences } from './flaw.js';
import { QUESTIONS } from './launch.js';
import { RitualSourceSchema } from './rituals.js';

/**
 * A Launch's deck (R3 E, D-179): five questions, each one a call of an admitted library Scroll as its authors wrote it, with
 * the right answer and the reason. Code chooses them; no model is asked, so a deck costs nothing and holds no text that a Scroll did
 * not already pass review for. An operator approves a deck before any member can play it. Pure.
 */

/** The longest reason a question shows after its answer. A call's own reason may be longer; its first sentences are kept. */
export const EXPLAIN_MAX = 280;
/** A Launch uses at most this many questions of one Scroll. */
const PER_SCROLL = 2;

export const LaunchQuestionSchema = z
  .strictObject({
    prompt: z.string().min(1).max(200),
    options: z.array(z.string().min(1).max(120)).min(2).max(3),
    /** Zero-based index of the right option. Never leaves the server before the question closes. */
    answer: z.number().int().min(0).max(2),
    explain: z.string().min(1).max(EXPLAIN_MAX),
    source: RitualSourceSchema.extend({ stopId: z.string().min(1).max(160) }),
  })
  .refine((question) => question.answer < question.options.length);
export type LaunchQuestion = z.infer<typeof LaunchQuestionSchema>;

/** The stored shape of a `launch` ritual item. */
export const LaunchDeckSchema = z.strictObject({ questions: z.array(LaunchQuestionSchema).length(QUESTIONS) });
export type LaunchDeck = z.infer<typeof LaunchDeckSchema>;

/** One call of a library Scroll, as the content read gives it (the part of `LibraryCallSource` a deck needs). */
export interface CallFacts {
  readonly stopId: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly answer: number;
  readonly explain: string;
}

/** A library Scroll's calls (the part of `LibraryCallSource` a deck needs). */
export interface CallSource {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly calls: readonly CallFacts[];
}

/** Identifies one call of one Scroll, for "not used lately". */
export const questionKey = (assetId: string, stopId: string): string => `${assetId}:${stopId}`;

/** The reason a question shows: the call's own first sentences that fit, never cut mid-sentence. None when even the first does not fit. */
export function shortExplain(explain: string): string | undefined {
  let kept = '';
  for (const sentence of splitSentences(explain.trim())) {
    const next = kept === '' ? sentence.text : `${kept} ${sentence.text}`;
    if (next.length > EXPLAIN_MAX) break;
    kept = next;
  }
  return kept === '' ? undefined : kept;
}

/** Text that shows as it is written: trimmed, with no control character. */
const isPrintable = (text: string): boolean =>
  text.trim() === text &&
  [...text].every((character) => {
    const point = character.codePointAt(0)!;
    return point >= 32 && (point < 127 || point > 159);
  });

/** A call as a question: everything must show as it is written, and the key must name one of the options. */
export function questionFrom(source: CallSource, call: CallFacts): LaunchQuestion | undefined {
  const explain = shortExplain(call.explain);
  const shown = [call.prompt, ...call.options, explain ?? ''];
  if (explain === undefined || !shown.every(isPrintable)) return undefined;
  const parsed = LaunchQuestionSchema.safeParse({
    prompt: call.prompt,
    options: call.options,
    answer: call.answer,
    explain,
    source: { assetId: source.assetId, assetRevision: source.assetRevision, stopId: call.stopId },
  });
  return parsed.success ? parsed.data : undefined;
}

/** A stable 32-bit mix of a text and a seed (FNV-1a), so the same room and day always order the same way. */
function mix(seed: number, text: string): number {
  let hash = (2_166_136_261 ^ seed) >>> 0;
  for (const character of text) hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0;
  return hash;
}

const orderBySeed = <T>(items: readonly T[], seed: number, keyOf: (item: T) => string): T[] =>
  items.toSorted((a, b) => mix(seed, keyOf(a)) - mix(seed, keyOf(b)) || keyOf(a).localeCompare(keyOf(b)));

/**
 * Takes up to `QUESTIONS` questions, one Scroll at a time (then a second round of the same), never the same prompt twice. In each
 * round a call the room was not asked lately (`avoid`) comes before one it was, so a small library is asked again only as far as it
 * must be.
 */
function pickFrom(sources: readonly CallSource[], seed: number, avoid: ReadonlySet<string>): LaunchQuestion[] {
  const perScroll = orderBySeed(sources, seed, (source) => source.assetId).map((source) =>
    orderBySeed(source.calls, seed, (call) => call.stopId)
      .flatMap((call) => {
        const question = questionFrom(source, call);
        const avoided = avoid.has(questionKey(source.assetId, call.stopId));
        return question === undefined ? [] : [{ question, avoided }];
      })
      .toSorted((a, b) => Number(a.avoided) - Number(b.avoided)),
  );
  const picked: LaunchQuestion[] = [];
  const prompts = new Set<string>();
  for (let turn = 0; turn < PER_SCROLL && picked.length < QUESTIONS; turn += 1) {
    const round = perScroll
      .flatMap((questions) => {
        const entry = questions[turn];
        return entry === undefined ? [] : [entry];
      })
      .toSorted((a, b) => Number(a.avoided) - Number(b.avoided));
    for (const { question } of round) {
      if (picked.length >= QUESTIONS) break;
      if (prompts.has(question.prompt)) continue;
      prompts.add(question.prompt);
      picked.push(question);
    }
  }
  return picked;
}

/**
 * Five questions for a room's night from the library Scrolls under its topic. Calls the room has not been asked lately (`avoid`,
 * by `questionKey`) are used first and a library too small for that is asked again only as far as it must be. The questions come from
 * different Scrolls where the library allows, at most two from one, in an order the seed fixes. `undefined` when the library does not
 * have five usable calls: nothing is made up.
 */
export function planDeck(
  sources: readonly CallSource[],
  seed: number,
  avoid: ReadonlySet<string>,
): LaunchDeck | undefined {
  const picked = pickFrom(sources, seed, avoid);
  if (picked.length !== QUESTIONS) return undefined;
  return LaunchDeckSchema.parse({ questions: orderBySeed(picked, seed, (question) => question.prompt) });
}

/**
 * Whether every question of a deck is still what its Scroll says: the same prompt, options, right answer and first sentences of the
 * reason, in the exact revision it cites. `current` finds that revision while it is still a served library Scroll. Approval and the
 * Launch itself both refuse a deck for which this is false, so a corrected or withdrawn Scroll never asks a question it no longer stands behind.
 */
export function deckStillHolds(
  deck: LaunchDeck,
  current: (assetId: string, assetRevision: number) => CallSource | undefined,
): boolean {
  return deck.questions.every((question) => {
    const source = current(question.source.assetId, question.source.assetRevision);
    const call = source?.calls.find((candidate) => candidate.stopId === question.source.stopId);
    if (source === undefined || call === undefined) return false;
    const now = questionFrom(source, call);
    return (
      now !== undefined &&
      now.prompt === question.prompt &&
      now.answer === question.answer &&
      now.explain === question.explain &&
      now.options.length === question.options.length &&
      now.options.every((option, index) => option === question.options[index])
    );
  });
}
