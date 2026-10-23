import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerSnapshot, type CurrentPlan, type PlannedOpportunity } from '../public.js';
import { PLAN_SHARE } from '../domain/plan.js';

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

describe('Composer reads the person’s Planner plan (labelled CI input fixtures)', () => {
  it('prefers the explanation a planned opportunity names and records which opportunity did it', () => {
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
      after: (1 - PLAN_SHARE) * 0.5 + PLAN_SHARE,
    });
    expect(named.features.intent).toBeCloseTo(0.625);
    // The plan shifts every candidate's Intent the same way; only the named explanation gains.
    expect(evaluationOf(withPlan, 'asset-0').features.intent).toBeCloseTo(0.375);
    expect(evaluationOf(withPlan, 'asset-0').plan).toBeUndefined();
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

  it('current intent wins: a plan cannot lift a candidate that misses the intent over one that matches it', () => {
    const candidates = [candidate(0, 'topic.a'), candidate(1, 'topic.b')];
    const plan = {
      revision: 3,
      opportunities: [opportunity({ topicIds: ['topic.b'], explanationUnitId: 'unit-1', formats: ['scroll'] })],
    };
    const d = composeEncounter(snapshot({ plan, intentTopics: ['topic.a'], candidates }));
    expect(evaluationOf(d, 'asset-0').features.intent).toBeCloseTo((1 - PLAN_SHARE) * 1);
    expect(evaluationOf(d, 'asset-1').features.intent).toBeCloseTo(PLAN_SHARE);
    expect(evaluationOf(d, 'asset-1').plan).toMatchObject({ match: 'unit' });
    expect(d.selection[0]?.assetId).toBe('asset-0');
  });

  it('a plan breaks ties among candidates the intent already accepts', () => {
    const plan = { revision: 3, opportunities: [opportunity({ explanationUnitId: 'unit-2' })] };
    const d = composeEncounter(snapshot({ plan, intentTopics: ['topic.a'] }));
    expect(evaluationOf(d, 'asset-2').features.intent).toBeCloseTo(1);
    expect(d.selection[0]?.assetId).toBe('asset-2');
  });

  it('respects the opportunity’s format preference, so the other format of the same explanation gets no lift', () => {
    const candidates = [candidate(0, 'topic.a', 'reel'), candidate(1, 'topic.a', 'scroll')];
    const plan = { revision: 1, opportunities: [opportunity({ explanationUnitId: 'unit-0', formats: ['scroll'] })] };
    const d = composeEncounter(snapshot({ plan, candidates }));
    expect(evaluationOf(d, 'asset-0').plan).toBeUndefined();
    // The scroll is not the named explanation, so it only shares the topic.
    expect(evaluationOf(d, 'asset-1').plan).toMatchObject({ match: 'topic' });
  });

  it('matches missing-supply opportunities by topic only, at half the strength', () => {
    const plan = {
      revision: 2,
      opportunities: [opportunity({ target: 'missing_supply', explanationUnitId: 'unit-1' })],
    };
    const d = composeEncounter(snapshot({ plan }));
    const influenced = d.evaluations.filter((e) => e.plan);
    expect(influenced).toHaveLength(3);
    for (const e of influenced) expect(e.plan).toMatchObject({ match: 'topic', after: 0.375 + PLAN_SHARE * 0.5 });
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

  it('a horizontal move blends the plan into Continuity, never past the admitted link', () => {
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
    const candidates = [linked(0, 0.8), linked(1, 0.7)];
    const plan = { revision: 5, opportunities: [opportunity({ topicIds: ['topic.z'], explanationUnitId: 'unit-1' })] };
    const d = composeEncounter({ ...snapshot({ mode: 'horizontal', plan, candidates }), source });
    expect(evaluationOf(d, 'asset-1').features.continuity).toBeCloseTo(0.75 * 0.7 + 0.25);
    expect(evaluationOf(d, 'asset-1').plan).toMatchObject({ feature: 'continuity', before: 0.7 });
    expect(evaluationOf(d, 'asset-0').features.continuity).toBeCloseTo(0.75 * 0.8);
    for (const e of d.evaluations) {
      expect(e.features.continuity).toBeGreaterThanOrEqual(0);
      expect(e.features.continuity).toBeLessThanOrEqual(1);
    }
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
