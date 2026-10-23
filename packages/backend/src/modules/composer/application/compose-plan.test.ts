import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerSnapshot, type CurrentPlan, type PlannedOpportunity } from '../public.js';
import { PLAN_LIFT } from '../domain/plan.js';

/** Labelled CI input fixtures: no provider output and no claim about real Planner quality. */
const EVALUATED_AT = '2026-10-20T12:00:00Z';
const LATER = '2026-10-21T12:00:00Z';

function candidate(index: number, topicId: string, kind: 'reel' | 'scroll' = 'scroll') {
  return {
    admitted: true,
    accessible: true,
    renderable: true,
    encounter: {
      assetId: `asset-${String(index)}`,
      assetRevision: 1,
      kind,
      explanationUnitId: `unit-${String(index)}`,
      metadata: { kind, title: `Fixture ${String(index)}`, summary: '', language: 'en' },
      topics: [{ topicId, role: 'primary' as const, weight: 1 }],
      facets: [`facet-${String(index)}`],
      siblings: [],
      catalogWatermark: 'fixture-catalog',
      attributionVersion: 'fixture-taxonomy',
    },
  };
}

function opportunity(overrides: Partial<PlannedOpportunity> = {}): PlannedOpportunity {
  return {
    move: 'limitation',
    topicIds: ['topic.a'],
    explanationUnitId: 'unit-1',
    eligibility: ['vertical', 'related'],
    formats: ['scroll'],
    expiresAt: LATER,
    target: 'existing',
    ...overrides,
  };
}

function snapshot(options: {
  readonly mode?: ComposerSnapshot['mode'];
  readonly plan?: CurrentPlan;
  readonly intentTopics?: readonly string[];
  readonly candidates?: ReturnType<typeof candidate>[];
}): ComposerSnapshot {
  const candidates = options.candidates ?? [candidate(0, 'topic.a'), candidate(1, 'topic.a'), candidate(2, 'topic.a')];
  return {
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt: EVALUATED_AT,
    seed: 'fixture-seed',
    mode: options.mode ?? 'vertical',
    intent: { language: 'en', topicIds: [...(options.intentTopics ?? [])], text: '' },
    candidates,
    explorationPool: [],
    ...(options.plan
      ? {
          evidence: {
            universeId: 'fixture-universe',
            privacyEpoch: 1,
            evaluatedAt: EVALUATED_AT,
            watermark: 'fixture-context',
            policyVersion: 'fixture-actual-activity',
            plan: options.plan,
            topics: [],
            recent: [],
            hiddenAssetIds: [],
          },
        }
      : {}),
    watermarks: {
      catalog: 'fixture-catalog',
      continuity: 'none',
      taxonomy: 'fixture-taxonomy',
      context: 'fixture-context',
    },
  };
}

const evaluationOf = (decision: ReturnType<typeof composeEncounter>, assetId: string) =>
  decision.evaluations.find((e) => e.assetId === assetId)!;

describe('Composer reads the person\u2019s Planner plan (labelled CI input fixtures)', () => {
  it('lifts the explanation a planned opportunity names among tied candidates and records which opportunity did it', () => {
    const plan = { revision: 7, opportunities: [opportunity({ topicIds: ['topic.z'], explanationUnitId: 'unit-1' })] };
    const withPlan = composeEncounter(snapshot({ plan }));
    const without = composeEncounter(snapshot({}));
    expect(without.selection[0]?.assetId).toBe('asset-0');
    expect(withPlan.selection[0]?.assetId).toBe('asset-1');
    const named = evaluationOf(withPlan, 'asset-1');
    expect(named.plan).toEqual({
      planRevision: 7,
      opportunity: 0,
      match: 'unit',
      feature: 'intent',
      before: 0.5,
      after: 0.5 + PLAN_LIFT,
    });
    expect(named.features.intent).toBeCloseTo(0.65);
    // Nobody else changes: the plan adds to one candidate and scales nothing down.
    for (const id of ['asset-0', 'asset-2']) {
      expect(evaluationOf(withPlan, id).features).toEqual(evaluationOf(without, id).features);
      expect(evaluationOf(withPlan, id).plan).toBeUndefined();
    }
  });

  it('leaves the decision exactly as before when there is no active opportunity', () => {
    const base = composeEncounter(snapshot({}));
    const expired = opportunity({ expiresAt: EVALUATED_AT });
    const wrongThread = opportunity({ eligibility: ['related'] });
    for (const opportunities of [[], [expired], [wrongThread]]) {
      const d = composeEncounter(snapshot({ plan: { revision: 1, opportunities } }));
      expect(d.evaluations.map((e) => e.features)).toEqual(base.evaluations.map((e) => e.features));
      expect(d.evaluations.every((e) => e.plan === undefined)).toBe(true);
      expect(d.selection).toEqual(base.selection);
    }
  });

  it('current intent wins even when the planned candidate is stronger on interest, format and novelty', () => {
    // A matches the intent topic. B is off-topic but is exactly what the plan names, and B is better on
    // every other feature. Without a plan A leads; the plan must not change that.
    const candidates = [candidate(0, 'topic.a'), candidate(1, 'topic.b')];
    const evidence = (plan?: CurrentPlan) => ({
      universeId: 'fixture-universe',
      privacyEpoch: 1,
      evaluatedAt: EVALUATED_AT,
      watermark: 'fixture-context',
      policyVersion: 'fixture-actual-activity',
      ...(plan ? { plan } : {}),
      topics: [
        { topicId: 'topic.a', activity: 0.2, formats: [] },
        { topicId: 'topic.b', activity: 20, formats: [{ kind: 'scroll' as const, measured: 9, qualified: 9 }] },
      ],
      recent: [],
      established: {
        policyVersion: 'fixture-history',
        watermark: 'fixture-history',
        units: [
          { explanationUnitId: 'unit-1', encountered: false, facets: [{ facetId: 'facet-1', encountered: false }] },
        ],
      },
      hiddenAssetIds: [],
    });
    const plan = { revision: 3, opportunities: [opportunity({ topicIds: ['topic.b'], explanationUnitId: 'unit-1' })] };
    const input = (withPlan: boolean) => ({
      ...snapshot({ intentTopics: ['topic.a'], candidates }),
      evidence: evidence(withPlan ? plan : undefined),
    });
    const without = composeEncounter(input(false));
    const withPlan = composeEncounter(input(true));
    expect(without.selection[0]?.assetId).toBe('asset-0');
    expect(evaluationOf(without, 'asset-1').features.interest).toBeGreaterThan(
      evaluationOf(without, 'asset-0').features.interest,
    );
    expect(withPlan.selection.map((r) => r.assetId)).toEqual(without.selection.map((r) => r.assetId));
    expect(withPlan.evaluations.map((e) => [e.features, e.score])).toEqual(
      without.evaluations.map((e) => [e.features, e.score]),
    );
    expect(withPlan.evaluations.every((e) => e.plan === undefined)).toBe(true);
  });

  it('does nothing when the intent already puts every candidate at its maximum', () => {
    const plan = { revision: 3, opportunities: [opportunity({ explanationUnitId: 'unit-2' })] };
    const d = composeEncounter(snapshot({ plan, intentTopics: ['topic.a'] }));
    for (const e of d.evaluations) {
      expect(e.features.intent).toBe(1);
      expect(e.plan).toBeUndefined();
    }
  });

  it('respects the opportunity\u2019s format preference, so the other format of the same explanation gets no lift', () => {
    const candidates = [candidate(0, 'topic.a', 'reel'), candidate(1, 'topic.a', 'scroll')];
    const plan = { revision: 1, opportunities: [opportunity({ explanationUnitId: 'unit-0', formats: ['scroll'] })] };
    const d = composeEncounter(snapshot({ plan, candidates }));
    expect(evaluationOf(d, 'asset-0').plan).toBeUndefined();
    // The scroll is not the named explanation, so it only shares the topic.
    expect(evaluationOf(d, 'asset-1').plan).toMatchObject({ match: 'topic', after: 0.5 + PLAN_LIFT / 2 });
  });

  it('matches missing-supply opportunities by topic only, at half the lift', () => {
    const plan = {
      revision: 2,
      opportunities: [opportunity({ target: 'missing_supply', explanationUnitId: 'unit-1' })],
    };
    const d = composeEncounter(snapshot({ plan }));
    const influenced = d.evaluations.filter((e) => e.plan);
    expect(influenced).toHaveLength(3);
    for (const e of influenced) expect(e.plan).toMatchObject({ match: 'topic', after: 0.5 + PLAN_LIFT / 2 });
  });

  it('the best opportunity wins and ties go to the higher priority', () => {
    const plan = {
      revision: 4,
      opportunities: [
        opportunity({ move: 'example', target: 'missing_supply', explanationUnitId: 'unit-9' }),
        opportunity({ move: 'mechanism', explanationUnitId: 'unit-1' }),
        opportunity({ move: 'consequence', explanationUnitId: 'unit-1' }),
      ],
    };
    const d = composeEncounter(snapshot({ plan }));
    expect(evaluationOf(d, 'asset-1').plan).toMatchObject({ opportunity: 1, match: 'unit' });
    expect(evaluationOf(d, 'asset-0').plan).toMatchObject({ opportunity: 0, match: 'topic' });
  });

  it('a horizontal move lifts Continuity only among equally linked candidates, never past 1', () => {
    const source = { assetId: 'source', assetRevision: 1 };
    const linked = (index: number, strength: number) => {
      const c = candidate(index, 'topic.a');
      return {
        ...c,
        continuity: {
          linkId: `link-${String(index)}`,
          source,
          target: { assetId: c.encounter.assetId, assetRevision: 1 },
          direction: 'related' as const,
          strength,
        },
      };
    };
    const plan = { revision: 5, opportunities: [opportunity({ topicIds: ['topic.z'], explanationUnitId: 'unit-1' })] };
    const tied = composeEncounter({
      ...snapshot({ mode: 'horizontal', plan, candidates: [linked(0, 0.8), linked(1, 0.8)] }),
      source,
    });
    expect(evaluationOf(tied, 'asset-1').features.continuity).toBeCloseTo(0.95);
    expect(evaluationOf(tied, 'asset-1').plan).toMatchObject({ feature: 'continuity', before: 0.8 });
    expect(evaluationOf(tied, 'asset-0').features.continuity).toBe(0.8);
    expect(tied.selection[0]?.assetId).toBe('asset-1');
    // A planned candidate behind a stronger link is not lifted past it.
    const behind = composeEncounter({
      ...snapshot({ mode: 'horizontal', plan, candidates: [linked(0, 0.8), linked(1, 0.7)] }),
      source,
    });
    expect(evaluationOf(behind, 'asset-1').plan).toBeUndefined();
    expect(behind.selection[0]?.assetId).toBe('asset-0');
    const capped = composeEncounter({
      ...snapshot({ mode: 'horizontal', plan, candidates: [linked(0, 0.97), linked(1, 0.97)] }),
      source,
    });
    expect(evaluationOf(capped, 'asset-1').features.continuity).toBe(1);
  });

  it('an exact target or a variant is not a place for a plan', () => {
    const plan = { revision: 1, opportunities: [opportunity({ explanationUnitId: 'unit-0' })] };
    const s = snapshot({ plan });
    const d = composeEncounter({
      ...s,
      mode: 'return',
      intent: { ...s.intent, exactTarget: { assetId: 'asset-1', assetRevision: 1 } },
    });
    expect(d.selection.map((r) => r.assetId)).toEqual(['asset-1']);
    expect(d.evaluations.every((e) => e.plan === undefined)).toBe(true);
  });

  it('replays exactly and refuses a malformed or oversized plan', () => {
    const plan = { revision: 1, opportunities: [opportunity()] };
    const input = snapshot({ plan });
    const d = composeEncounter(input);
    expect(composeEncounter(d.input)).toEqual(d);
    const evidence = input.evidence!;
    const four = { revision: 1, opportunities: Array.from({ length: 4 }, () => opportunity()) };
    expect(() => composeEncounter({ ...input, evidence: { ...evidence, plan: four } })).toThrow();
    const withModelText = { ...plan, opportunities: [{ ...opportunity(), title: 'private model text' }] };
    expect(() => composeEncounter({ ...input, evidence: { ...evidence, plan: withModelText } })).toThrow();
  });
});
