import { describe, expect, it } from 'vitest';
import {
  LOST_WAITER_GRACE_MS,
  PlannedIntentSchema,
  isLostWaiter,
  plannedOutcomeCounts,
  storablePlannedIntent,
  type PlannedDemandOutcome,
} from './planned-demand.js';

const WAIT_LIMIT = 30 * 60_000;

describe('what the outcome counters add for a plan', () => {
  it('names every kind of outcome with its reason, and counts the ones that are alike together', () => {
    const outcomes: PlannedDemandOutcome[] = [
      { kind: 'ready', requestId: 'a' },
      { kind: 'ready', requestId: 'b' },
      { kind: 'already_recorded', requestId: 'c', open: 'deferred' },
      { kind: 'already_recorded', requestId: 'd', open: 'ready' },
      { kind: 'deferred', requestId: 'e', joined: false },
      { kind: 'deferred', requestId: 'f', joined: true },
      { kind: 'not_commissioned', reason: 'no_production_path' },
      { kind: 'not_commissioned', reason: 'cap_reached' },
      { kind: 'not_commissioned', reason: 'create_off' },
      { kind: 'not_commissioned', reason: 'no_recipe_left' },
      { kind: 'unsupported', reason: 'topic_not_in_catalogue' },
      { kind: 'unsupported', reason: 'language_not_supported' },
    ];
    expect(plannedOutcomeCounts(outcomes)).toEqual([
      { outcome: 'already_recorded', reason: 'reusable', total: 1 },
      { outcome: 'already_recorded', reason: 'waiting', total: 1 },
      { outcome: 'commissioned', reason: '', total: 1 },
      { outcome: 'joined', reason: '', total: 1 },
      { outcome: 'not_commissioned', reason: 'cap_reached', total: 1 },
      { outcome: 'not_commissioned', reason: 'create_off', total: 1 },
      { outcome: 'not_commissioned', reason: 'no_production_path', total: 1 },
      { outcome: 'not_commissioned', reason: 'no_recipe_left', total: 1 },
      { outcome: 'reused', reason: '', total: 2 },
      { outcome: 'unsupported', reason: 'language_not_supported', total: 1 },
      { outcome: 'unsupported', reason: 'topic_not_in_catalogue', total: 1 },
    ]);
  });

  it('counts a lost waiter the call closed beside what the call itself decided', () => {
    expect(
      plannedOutcomeCounts([
        { kind: 'deferred', requestId: 'new', joined: true, expiredRequestId: 'old' },
        { kind: 'not_commissioned', reason: 'no_recipe_left', expiredRequestId: 'older' },
      ]),
    ).toEqual([
      { outcome: 'expired', reason: 'no_resolver', total: 2 },
      { outcome: 'joined', reason: '', total: 1 },
      { outcome: 'not_commissioned', reason: 'no_recipe_left', total: 1 },
    ]);
  });

  it('is empty for a plan with no missing-supply opportunity, and the same whatever order the outcomes came in', () => {
    expect(plannedOutcomeCounts([])).toEqual([]);
    const a: PlannedDemandOutcome = { kind: 'unsupported', reason: 'topic_not_in_catalogue' };
    const b: PlannedDemandOutcome = { kind: 'ready', requestId: 'x' };
    expect(plannedOutcomeCounts([a, b])).toEqual(plannedOutcomeCounts([b, a]));
  });
});

describe('a waiter that lost its resolver', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  const waitingFor = (ms: number) => new Date(now.getTime() - ms);

  it('is called lost only after the wait limit and the grace, so a slow resolver is not raced', () => {
    expect(isLostWaiter(waitingFor(WAIT_LIMIT - 1), now, WAIT_LIMIT)).toBe(false);
    expect(isLostWaiter(waitingFor(WAIT_LIMIT), now, WAIT_LIMIT)).toBe(false);
    expect(isLostWaiter(waitingFor(WAIT_LIMIT + LOST_WAITER_GRACE_MS - 1), now, WAIT_LIMIT)).toBe(false);
    expect(isLostWaiter(waitingFor(WAIT_LIMIT + LOST_WAITER_GRACE_MS), now, WAIT_LIMIT)).toBe(true);
    expect(isLostWaiter(waitingFor(24 * 60 * 60_000), now, WAIT_LIMIT)).toBe(true);
  });
});

describe("the intent a plan keeps on the person's own demand", () => {
  const intent = { version: 'planned-intent.v1', move: 'limitation', explanationUnitId: 'unit-1', brief: 'A brief.' };

  it("accepts the move, the unit and the brief within the planner's own bounds", () => {
    expect(PlannedIntentSchema.parse(intent)).toEqual(intent);
    expect(PlannedIntentSchema.safeParse({ ...intent, brief: 'x'.repeat(800) }).success).toBe(true);
    expect(PlannedIntentSchema.safeParse({ ...intent, explanationUnitId: 'u'.repeat(160) }).success).toBe(true);
  });

  it('refuses anything beyond them, and anything extra', () => {
    for (const bad of [
      { ...intent, brief: 'x'.repeat(801) },
      { ...intent, brief: '' },
      { ...intent, explanationUnitId: 'u'.repeat(161) },
      { ...intent, move: 'Not A Move' },
      { ...intent, move: '' },
      { ...intent, version: 'planned-intent.v2' },
      { ...intent, evidenceRefs: ['x'] },
    ])
      expect(PlannedIntentSchema.safeParse(bad).success).toBe(false);
  });
});

describe('the intent as the database can keep it', () => {
  const intent = {
    version: 'planned-intent.v1',
    move: 'mechanism',
    explanationUnitId: 'unit-1',
    brief: 'A brief.',
  } as const;
  /** The bytes of the `jsonb` text of an intent: `jsonb` writes `"key": value, "key": value`. */
  const jsonbBytes = (value: object | undefined) =>
    new TextEncoder().encode(
      `{${Object.entries(value ?? {})
        .map(([key, text]) => `${JSON.stringify(key)}: ${JSON.stringify(text)}`)
        .join(', ')}}`,
    ).length;

  it('keeps an ordinary intent exactly as it is', () => {
    expect(storablePlannedIntent(intent)).toEqual(intent);
    expect(
      storablePlannedIntent({ ...intent, brief: 'x'.repeat(800), explanationUnitId: 'u'.repeat(160) }),
    ).toMatchObject({
      brief: 'x'.repeat(800),
    });
  });

  it('drops what fails the schema, and never throws for any input', () => {
    for (const bad of [
      undefined,
      null,
      'a brief',
      {},
      { ...intent, brief: '' },
      { ...intent, brief: 'x'.repeat(801) },
      { ...intent, move: 'Not A Move' },
      { ...intent, extra: true },
    ])
      expect(storablePlannedIntent(bad)).toBeUndefined();
  });

  it('removes what jsonb refuses: NUL, and a surrogate half with no partner', () => {
    expect(storablePlannedIntent({ ...intent, brief: 'a\u0000b' })?.brief).toBe('ab');
    expect(storablePlannedIntent({ ...intent, brief: 'a\uD800b' })?.brief).toBe('a\uFFFDb');
    expect(storablePlannedIntent({ ...intent, brief: 'a\uDC00' })?.brief).toBe('a\uFFFD');
    // A real pair (an emoji) is left alone.
    expect(storablePlannedIntent({ ...intent, brief: 'a\u{1F600}b' })?.brief).toBe('a\u{1F600}b');
    // Nothing left after cleaning is no intent.
    expect(storablePlannedIntent({ ...intent, brief: '\u0000\u0000' })).toBeUndefined();
    expect(storablePlannedIntent({ ...intent, explanationUnitId: '\u0000' })).toBeUndefined();
  });

  it("cuts a brief that would exceed the column's bytes (control characters escape to six each), never past what fits", () => {
    const heavy = { ...intent, brief: '\u0001'.repeat(800), explanationUnitId: 'u'.repeat(160) };
    // As given it would be over the 4096-byte check: the guard exists because the schema alone does not bound it.
    expect(jsonbBytes(heavy)).toBeGreaterThan(4096);
    const kept = storablePlannedIntent(heavy);
    expect(kept).toBeDefined();
    expect(jsonbBytes(kept)).toBeLessThanOrEqual(4096);
    expect(kept!.brief.length).toBeGreaterThan(300);
    expect(kept!.brief.length).toBeLessThan(800);
    expect(kept!.explanationUnitId).toBe(heavy.explanationUnitId);
    // Four-byte characters at the longest allowed length fit as they are.
    const wide = storablePlannedIntent({
      ...intent,
      brief: '\u{1F600}'.repeat(400),
      explanationUnitId: '\u{1F600}'.repeat(80),
    });
    expect(wide?.brief).toBe('\u{1F600}'.repeat(400));
  });

  it('is cut on a character boundary, so a pair is never split', () => {
    const kept = storablePlannedIntent({ ...intent, brief: '\u0001'.repeat(450) + '\u{1F600}'.repeat(350) });
    expect(kept?.brief).not.toMatch(/\uFFFD/u);
    expect(jsonbBytes(kept)).toBeLessThanOrEqual(4096);
  });
});
