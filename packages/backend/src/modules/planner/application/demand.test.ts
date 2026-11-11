import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { PlannedDemandInput, PlannedDemandOutcome } from '../../supply/public.js';
import { PlannedIntentSchema } from '../../supply/public.js';
import type { Opportunity } from '../domain/proposal.js';
import { plannedIntentOf, recordMissingSupplyDemand } from './demand.js';
import type { PlannerPorts } from './ports.js';

const scope = {} as PersonalScopeTx;
const base: Omit<Opportunity, 'move' | 'explanationUnitId' | 'target'> = {
  title: 'A title',
  purpose: 'A purpose.',
  topicIds: ['earth.tides'],
  evidenceRefs: ['evidence-1'],
  eligibility: ['vertical'],
  formats: ['scroll'],
  expiresAt: '2026-11-12T00:00:00.000Z',
};
const missing = (unit: string, brief: string, move: Opportunity['move'] = 'mechanism'): Opportunity => ({
  ...base,
  move,
  explanationUnitId: unit,
  target: { kind: 'missing_supply', brief },
});
const existing: Opportunity = {
  ...base,
  move: 'example',
  explanationUnitId: 'unit-existing',
  target: {
    kind: 'existing',
    assetId: '0199a000-0000-7000-8000-000000000001',
    assetRevision: 1,
    catalogWatermark: 'w',
  },
};

function ports(outcomes: readonly PlannedDemandOutcome[]) {
  const recorded: PlannedDemandInput[] = [];
  const counted: (readonly PlannedDemandOutcome[])[] = [];
  const events: string[] = [];
  let next = 0;
  const p = {
    capabilities: {},
    recordDemand: (_scope: unknown, input: PlannedDemandInput) => {
      events.push('record');
      recorded.push(input);
      return Promise.resolve(outcomes[next++]!);
    },
    countDemand: (_scope: unknown, all: readonly PlannedDemandOutcome[]) => {
      events.push('count');
      counted.push(all);
      return Promise.resolve();
    },
  } as unknown as Pick<PlannerPorts, 'recordDemand' | 'countDemand' | 'capabilities'>;
  return { p, recorded, counted, events };
}

describe('what the model wanted of a missing-supply opportunity', () => {
  it('is its move, its explanation unit and its brief, within the bounds Supply checks', () => {
    const intent = plannedIntentOf(missing('unit-1', 'A brief.', 'limitation'));
    expect(intent).toEqual({
      version: 'planned-intent.v1',
      move: 'limitation',
      explanationUnitId: 'unit-1',
      brief: 'A brief.',
    });
    expect(PlannedIntentSchema.safeParse(intent).success).toBe(true);
    // Never the title, the purpose, the topics or the evidence references.
    expect(Object.keys(intent!).sort()).toEqual(['brief', 'explanationUnitId', 'move', 'version']);
  });

  it('is absent for an opportunity that names admitted content', () => {
    expect(plannedIntentOf(existing)).toBeUndefined();
  });

  it("fits Supply's bounds for every move the Planner may propose", () => {
    for (const move of ['example', 'mechanism', 'limitation', 'consequence', 'perspective', 'connection'] as const)
      expect(
        PlannedIntentSchema.safeParse(plannedIntentOf(missing('u'.repeat(160), 'b'.repeat(800), move))).success,
      ).toBe(true);
  });
});

describe("the Planner's missing-supply demand of an accepted plan", () => {
  const plan = (opportunities: readonly Opportunity[]) => ({
    runId: 'run-1',
    language: 'en',
    alreadyMet: ['unit-met'],
    opportunities,
  });

  it('asks Supply for each missing-supply opportunity only, passing its intent and its slot', async () => {
    const w = ports([
      { kind: 'deferred', requestId: 'r1', joined: false },
      { kind: 'ready', requestId: 'r2' },
    ]);
    await recordMissingSupplyDemand(
      w.p,
      scope,
      plan([missing('u1', 'Brief one.'), existing, missing('u2', 'Brief two.', 'connection')]),
    );
    expect(
      w.recorded.map((input) => [input.slot, input.intent.explanationUnitId, input.intent.brief, input.intent.move]),
    ).toEqual([
      [0, 'u1', 'Brief one.', 'mechanism'],
      [2, 'u2', 'Brief two.', 'connection'],
    ]);
    expect(w.recorded.every((input) => input.alreadyMet.includes('unit-met') && input.language === 'en')).toBe(true);
  });

  it('counts every outcome of the plan once, after all are recorded, including the ones that stored nothing', async () => {
    const outcomes: PlannedDemandOutcome[] = [
      { kind: 'not_commissioned', reason: 'no_recipe_left' },
      { kind: 'unsupported', reason: 'topic_not_in_catalogue' },
      { kind: 'already_recorded', requestId: 'r', open: 'deferred' },
    ];
    const w = ports(outcomes);
    const returned = await recordMissingSupplyDemand(
      w.p,
      scope,
      plan([missing('u1', 'a'), missing('u2', 'b'), missing('u3', 'c')]),
    );
    expect(returned).toEqual(outcomes);
    expect(w.counted).toEqual([outcomes]);
    expect(w.events).toEqual(['record', 'record', 'record', 'count']);
  });

  it('records nothing and counts nothing for a plan that needs no supply', async () => {
    const w = ports([]);
    expect(await recordMissingSupplyDemand(w.p, scope, plan([existing]))).toEqual([]);
    expect(w.recorded).toEqual([]);
    expect(w.counted).toEqual([]);
  });
});
