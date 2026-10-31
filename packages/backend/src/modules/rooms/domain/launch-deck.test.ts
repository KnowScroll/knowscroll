import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_MAX,
  LaunchDeckSchema,
  deckStillHolds,
  planDeck,
  questionFrom,
  questionKey,
  shortExplain,
  type CallFacts,
  type CallSource,
} from './launch-deck.js';

/** Labelled fixtures: Scrolls and calls written for these tests, never a library's. */
const call = (stopId: string, over: Partial<CallFacts> = {}): CallFacts => ({
  stopId,
  prompt: `What happens at ${stopId}?`,
  options: ['It speeds up', 'It slows down', 'It stays the same'],
  answer: 1,
  explain: 'It slows down. The reason is the one the Scroll gives. A second sentence follows.',
  ...over,
});
const scroll = (n: number, stops: readonly string[]): CallSource => ({
  assetId: `0199b000-0000-7000-8000-00000000000${String(n)}`,
  assetRevision: 1,
  calls: stops.map((stop) => call(`s${String(n)}${stop}`)),
});

describe('a Launch deck (D-179)', () => {
  const library = [scroll(1, ['a', 'b']), scroll(2, ['a', 'b']), scroll(3, ['a']), scroll(4, ['a']), scroll(5, ['a'])];

  it('chooses five questions from different Scrolls first, at most two from one', () => {
    const deck = planDeck(library, 7, new Set());
    expect(deck?.questions).toHaveLength(5);
    expect(new Set(deck?.questions.map((question) => question.source.assetId)).size).toBe(5);
    const small = planDeck([scroll(1, ['a', 'b', 'c']), scroll(2, ['a', 'b', 'c'])], 7, new Set());
    expect(small).toBeUndefined();
    const three = planDeck(
      [scroll(1, ['a', 'b', 'c']), scroll(2, ['a', 'b', 'c']), scroll(3, ['a', 'b'])],
      7,
      new Set(),
    );
    const perScroll = new Map<string, number>();
    for (const question of three?.questions ?? [])
      perScroll.set(question.source.assetId, (perScroll.get(question.source.assetId) ?? 0) + 1);
    expect(Math.max(...perScroll.values())).toBeLessThanOrEqual(2);
  });

  it('is the same for the same seed and different for another', () => {
    expect(planDeck(library, 7, new Set())).toEqual(planDeck(library, 7, new Set()));
    const orders = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        planDeck(library, seed, new Set())
          ?.questions.map((q) => q.prompt)
          .join('|'),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('passes over calls the room was asked lately, and falls back when the library is too small', () => {
    const lately = new Set([questionKey(library[0]!.assetId, 's1a'), questionKey(library[1]!.assetId, 's2a')]);
    const deck = planDeck(library, 7, lately);
    const keys = deck?.questions.map((q) => questionKey(q.source.assetId, q.source.stopId));
    expect(keys).toHaveLength(5);
    for (const key of lately) expect(keys).not.toContain(key);
    // Every call is recent: the room is asked again rather than being given nothing.
    const everything = new Set(
      library.flatMap((source) => source.calls.map((c) => questionKey(source.assetId, c.stopId))),
    );
    expect(planDeck(library, 7, everything)?.questions).toHaveLength(5);
  });

  it('makes nothing when the library has fewer than five usable calls, and invents nothing', () => {
    expect(
      planDeck([scroll(1, ['a']), scroll(2, ['a']), scroll(3, ['a']), scroll(4, ['a'])], 7, new Set()),
    ).toBeUndefined();
    expect(planDeck([], 7, new Set())).toBeUndefined();
  });

  it('keeps the first sentences of a reason that fit and refuses a call whose first sentence does not', () => {
    expect(shortExplain('One. Two.')).toBe('One. Two.');
    const long = `${'Word '.repeat(40).trim()}. Short.`;
    expect(long.length).toBeGreaterThan(EXPLAIN_MAX - 120);
    expect(shortExplain(`${'x'.repeat(EXPLAIN_MAX + 5)}.`)).toBeUndefined();
    const source = scroll(1, ['a']);
    expect(questionFrom(source, call('s1a', { explain: `${'x'.repeat(EXPLAIN_MAX + 5)}.` }))).toBeUndefined();
    expect(questionFrom(source, call('s1a', { prompt: 'Has a\u0007control' }))).toBeUndefined();
    expect(questionFrom(source, call('s1a', { options: ['Only one'], answer: 0 }))).toBeUndefined();
    expect(questionFrom(source, call('s1a'))?.explain).toBe(
      'It slows down. The reason is the one the Scroll gives. A second sentence follows.',
    );
  });

  it('refuses a stored deck that is not five questions with a key among the options', () => {
    const deck = planDeck(library, 7, new Set())!;
    expect(LaunchDeckSchema.safeParse(deck).success).toBe(true);
    expect(LaunchDeckSchema.safeParse({ questions: deck.questions.slice(0, 4) }).success).toBe(false);
    const badKey = {
      questions: deck.questions.map((question, index) =>
        index === 0 ? { ...question, answer: 2, options: ['a', 'b'] } : question,
      ),
    };
    expect(LaunchDeckSchema.safeParse(badKey).success).toBe(false);
    expect(LaunchDeckSchema.safeParse({ ...deck, extra: 1 }).success).toBe(false);
  });

  it('holds only while every Scroll still says the same thing', () => {
    const deck = planDeck(library, 7, new Set())!;
    const current = (assetId: string, assetRevision: number) =>
      library.find((source) => source.assetId === assetId && source.assetRevision === assetRevision);
    expect(deckStillHolds(deck, current)).toBe(true);
    expect(deckStillHolds(deck, () => undefined)).toBe(false);
    const changed = (assetId: string, assetRevision: number): CallSource | undefined => {
      const source = current(assetId, assetRevision);
      return source === undefined
        ? undefined
        : { ...source, calls: source.calls.map((c) => ({ ...c, answer: (c.answer + 1) % 3 })) };
    };
    expect(deckStillHolds(deck, changed)).toBe(false);
  });
});
