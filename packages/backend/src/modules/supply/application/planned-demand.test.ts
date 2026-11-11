import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { WAIT_LIMIT_MS } from './commission.js';
import type { Demand, PlannedDemandInput, SupplyPorts } from './ports.js';
import { makeCountPlannedDemand, makeRecordPlannedDemand } from './requests.js';

const scope = { revisionAtEntry: 4 } as PersonalScopeTx;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const intent = {
  version: 'planned-intent.v1',
  move: 'mechanism',
  explanationUnitId: 'unit-1',
  brief: "The model's own brief.",
} as const;
const input = (overrides: Partial<PlannedDemandInput> = {}): PlannedDemandInput => ({
  plannerRunId: 'run-1',
  slot: 0,
  topicIds: ['earth.tides'],
  format: 'scroll',
  language: 'en',
  capabilities: {} as PlannedDemandInput['capabilities'],
  alreadyMet: [],
  intent,
  ...overrides,
});

/** In-memory ports: the rules of recording planned demand, without a database. Nothing is admitted, so Reuse never serves. */
function world(
  options: {
    open?: { id: string; state: 'deferred' | 'ready'; waitingSince: Date };
    recipe?: string;
    cap?: number;
  } = {},
) {
  const inserted: Demand[] = [];
  const closed: string[] = [];
  const sent: string[] = [];
  let open = options.open;
  let ids = 0;
  const ports = {
    now: () => NOW,
    newId: () => `id-${String((ids += 1))}`,
    readCandidates: () => Promise.resolve([]),
    lockCurrent: () => Promise.resolve([]),
    createDailyCaps: { person: options.cap ?? 5, planner: options.cap ?? 5 },
    store: {
      findOpenPlanned: () => Promise.resolve(open),
      closeLostPlanned: (_scope: unknown, id: string) => {
        closed.push(id);
        open = undefined;
        return Promise.resolve(true);
      },
      insert: (_scope: unknown, demand: Demand) => {
        inserted.push(demand);
        return Promise.resolve();
      },
      lockCommissioning: () => Promise.resolve(),
      findActiveWork: () => Promise.resolve(undefined),
      closeWork: () => Promise.resolve(),
      countCommissionedSince: () => Promise.resolve(0),
      joinOrCreate: (_scope: unknown, _brief: unknown, id: string) => Promise.resolve({ id, joined: false }),
    },
    readProduction: () => Promise.resolve({ state: 'not_started', take: 1 }),
    chooseRecipe: () =>
      Promise.resolve(
        options.recipe === undefined
          ? { kind: 'none' as const }
          : { kind: 'recipe' as const, recipe: options.recipe, take: 1 },
      ),
    enqueueProduction: (_scope: unknown, recipe: string) => {
      sent.push(`production ${recipe}`);
      return Promise.resolve();
    },
    enqueue: (_scope: unknown, requestId: string) => {
      sent.push(`resolver ${requestId}`);
      return Promise.resolve();
    },
  } as unknown as SupplyPorts;
  return { record: makeRecordPlannedDemand(ports), inserted, closed, sent };
}

describe("recording the Planner's demand", () => {
  it('stores what the model wanted on the demand row it commissions', async () => {
    const w = world({ recipe: 'tides' });
    const outcome = await w.record(scope, input());
    expect(outcome).toEqual({ kind: 'deferred', requestId: 'id-2', joined: false });
    expect(w.inserted).toHaveLength(1);
    expect(w.inserted[0]).toMatchObject({
      plannedIntent: intent,
      planned: { runId: 'run-1', slot: 0 },
      status: 'deferred',
    });
    // Supply still chooses by code: the model's brief is in neither the canonical brief nor the command.
    const shared = JSON.stringify([w.inserted[0]!.brief, w.inserted[0]!.command]);
    expect(shared).not.toContain('The model');
    expect(w.sent).toEqual(['production tides', 'resolver id-2']);
  });

  it("never fails the plan for the model's intent: one it cannot keep is cleaned, cut or left out", async () => {
    const odd = world({ recipe: 'tides' });
    // NUL and a lone surrogate would make the insert fail; control characters would break the column's byte bound.
    await odd.record(scope, input({ intent: { ...intent, brief: 'a\u0000b\uD800c' } }));
    expect(odd.inserted[0]?.plannedIntent?.brief).toBe('ab\uFFFDc');
    const heavy = world({ recipe: 'tides' });
    await heavy.record(scope, input({ intent: { ...intent, brief: '\u0001'.repeat(800) } }));
    expect(heavy.inserted[0]?.plannedIntent?.brief.length).toBeLessThan(800);
    expect(heavy.inserted[0]?.plannedIntent?.brief.length).toBeGreaterThan(0);
    const bad = world({ recipe: 'tides' });
    const malformed = { ...intent, move: 'Not A Move' } as unknown as PlannedDemandInput['intent'];
    expect(await bad.record(scope, input({ intent: malformed }))).toMatchObject({ kind: 'deferred' });
    expect(bad.inserted).toHaveLength(1);
    expect(bad.inserted[0]).not.toHaveProperty('plannedIntent');
    expect(bad.sent).toEqual(['production tides', 'resolver id-2']);
  });

  it('says why nothing was started, stores nothing, and sends nothing', async () => {
    const reel = world({ recipe: 'tides' });
    expect(await reel.record(scope, input({ format: 'reel' }))).toEqual({
      kind: 'not_commissioned',
      reason: 'no_production_path',
    });
    const none = world({});
    expect(await none.record(scope, input())).toEqual({ kind: 'not_commissioned', reason: 'no_recipe_left' });
    const off = world({ recipe: 'tides', cap: 0 });
    expect(await off.record(scope, input())).toEqual({ kind: 'not_commissioned', reason: 'create_off' });
    for (const w of [reel, none, off]) {
      expect(w.inserted).toEqual([]);
      expect(w.sent).toEqual([]);
    }
  });

  it('says why a brief is not one Supply can serve', async () => {
    const w = world({ recipe: 'tides' });
    expect(await w.record(scope, input({ topicIds: ['ci.not-a-catalogue-topic'] }))).toEqual({
      kind: 'unsupported',
      reason: 'topic_not_in_catalogue',
    });
    expect(await w.record(scope, input({ language: 'fr' }))).toEqual({
      kind: 'unsupported',
      reason: 'language_not_supported',
    });
    expect(w.inserted).toEqual([]);
  });

  it('leaves a waiting demand alone while a live resolver may still close it', async () => {
    const waiting = { id: 'old', state: 'deferred' as const };
    const w = world({ recipe: 'tides', open: { ...waiting, waitingSince: minutesAgo(WAIT_LIMIT_MS / 60_000 + 5) } });
    expect(await w.record(scope, input())).toEqual({ kind: 'already_recorded', requestId: 'old', open: 'deferred' });
    expect(w.closed).toEqual([]);
    expect(w.inserted).toEqual([]);
  });

  it('closes a waiting demand that lost its resolver, and decides the brief afresh', async () => {
    const lost = { id: 'old', state: 'deferred' as const, waitingSince: minutesAgo(WAIT_LIMIT_MS / 60_000 + 11) };
    const w = world({ recipe: 'tides', open: lost });
    const outcome = await w.record(scope, input());
    expect(w.closed).toEqual(['old']);
    expect(outcome).toMatchObject({ kind: 'deferred', expiredRequestId: 'old' });
    expect(w.inserted).toHaveLength(1);
    // Even when nothing can be started, the lost demand is closed and the outcome says so.
    const stuck = world({ open: lost });
    expect(await stuck.record(scope, input())).toEqual({
      kind: 'not_commissioned',
      reason: 'no_recipe_left',
      expiredRequestId: 'old',
    });
    expect(stuck.closed).toEqual(['old']);
  });

  it('never closes a demand that already holds content, however old it is', async () => {
    const w = world({
      recipe: 'tides',
      open: { id: 'ready-one', state: 'ready', waitingSince: minutesAgo(24 * 60) },
    });
    // Nothing unread is admitted now, so the brief is decided afresh beside it; the old ready row is untouched.
    expect(await w.record(scope, input())).toMatchObject({ kind: 'deferred' });
    expect(w.closed).toEqual([]);
  });
});

describe('counting the outcomes of a plan', () => {
  const ledger = () => {
    const calls: { when: Date; counts: unknown }[] = [];
    const ports = {
      now: () => NOW,
      plannedLedger: {
        add: (_scope: unknown, when: Date, counts: unknown) => {
          calls.push({ when, counts });
          return Promise.resolve();
        },
      },
    } as unknown as Pick<SupplyPorts, 'plannedLedger' | 'now'>;
    return { calls, count: makeCountPlannedDemand(ports) };
  };

  it('adds the whole plan to the counters in one write, in a fixed order', async () => {
    const l = ledger();
    await l.count(scope, [
      { kind: 'unsupported', reason: 'language_not_supported' },
      { kind: 'ready', requestId: 'a' },
      { kind: 'ready', requestId: 'b' },
    ]);
    expect(l.calls).toEqual([
      {
        when: NOW,
        counts: [
          { outcome: 'reused', reason: '', total: 2 },
          { outcome: 'unsupported', reason: 'language_not_supported', total: 1 },
        ],
      },
    ]);
  });

  it('writes nothing for a plan with no outcome', async () => {
    const l = ledger();
    await l.count(scope, []);
    expect(l.calls).toEqual([]);
  });
});
