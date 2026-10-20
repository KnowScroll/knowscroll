import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerSnapshot } from '../public.js';
import { score } from '../domain/features.js';
function ref(value: { readonly assetId: string; readonly assetRevision: number }) {
  return { assetId: value.assetId, assetRevision: value.assetRevision };
}
function fixture(count = 5): ComposerSnapshot {
  return {
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt: '2026-10-20T12:00:00Z',
    seed: 'fixture-seed',
    mode: 'vertical',
    intent: { language: 'en', topicIds: [], text: '' },
    watermarks: {
      catalog: 'fixture-catalog',
      continuity: 'fixture-links',
      taxonomy: 'fixture-taxonomy',
      context: 'fixture-none',
    },
    explorationPool: [],
    candidates: Array.from({ length: count }, (_, i) => ({
      admitted: true,
      accessible: true,
      renderable: true,
      encounter: {
        assetId: `asset-${String(i)}`,
        assetRevision: 1,
        kind: i % 2 === 0 ? 'reel' : 'scroll',
        explanationUnitId: `explanation-${String(i)}`,
        metadata: { kind: i % 2 === 0 ? 'reel' : 'scroll', title: `Fixture ${String(i)}`, summary: '', language: 'en' },
        topics: [{ topicId: 'fixture.topic', role: 'primary', weight: 1 }],
        facets: [`facet-${String(i)}`],
        siblings: [],
        catalogWatermark: 'fixture-catalog',
        attributionVersion: 'fixture-taxonomy',
      },
    })),
  };
}
function withEvidence(s: ComposerSnapshot): ComposerSnapshot {
  return {
    ...s,
    evidence: {
      universeId: s.universeId,
      privacyEpoch: s.privacyEpoch,
      evaluatedAt: s.evaluatedAt,
      watermark: s.watermarks.context,
      policyVersion: 'fixture-actual-activity',
      topics: [],
      recent: [],
      hiddenAssetIds: [],
    },
  };
}
describe('Composer v0 pure policy (labelled CI input fixtures)', () => {
  it('uses the exact vertical and horizontal equations', () => {
    const f = {
      intent: 0.8,
      interest: 0.6,
      format: 0.7,
      novelty: 0.9,
      semanticFit: 0.8,
      recentRepetition: 0.1,
      continuity: 0.4,
    };
    expect(score(f, false)).toBeCloseTo(0.735);
    expect(score(f, true)).toBeCloseTo(0.58);
  });
  it('unknown history and semantic assessment are explicit neutral baseline inputs', () => {
    const d = composeEncounter(fixture(1));
    expect(d.evaluations[0]?.features).toMatchObject({
      interest: 0.5,
      format: 0.5,
      semanticFit: 0.5,
      continuity: 0.5,
      recentRepetition: 0,
    });
    expect(d.fallbackVersion).toBe('lexical-admitted.v0');
  });
  it('computes topic-local format (1+Q)/(2+O) and A/(1+A), unknown excluded', () => {
    const s = withEvidence(fixture(2));
    const d = composeEncounter({
      ...s,
      evidence: {
        ...s.evidence!,
        topics: [{ topicId: 'fixture.topic', activity: 3, formats: [{ kind: 'reel', measured: 5, qualified: 4 }] }],
      },
    });
    expect(d.evaluations[0]?.features.format).toBeCloseTo(5 / 7);
    expect(d.evaluations[1]?.features.format).toBe(0.5);
    expect(d.evaluations[0]?.features.interest).toBe(0.75);
  });
  it('explicit format and exact revision beat preference and pool selection', () => {
    const s = fixture();
    const chosen = s.candidates[1]!.encounter;
    const d = composeEncounter({
      ...s,
      mode: 'return',
      intent: { ...s.intent, format: 'scroll', exactTarget: ref(chosen) },
      explorationPool: s.candidates.map((c) => ref(c.encounter)),
    });
    expect(d.selection).toHaveLength(1);
    expect(d.selection[0]?.assetId).toBe(chosen.assetId);
    expect(d.exploration.fraction).toBe(0);
    expect(
      composeEncounter({ ...s, intent: { ...s.intent, exactTarget: { ...ref(chosen), assetRevision: 2 } } }).outcome,
    ).toBe('exhausted');
  });
  it('unknown attribution cannot match a hard topic but remains general discovery supply', () => {
    const s = fixture(1);
    const c = s.candidates[0]!;
    const input = { ...s, candidates: [{ ...c, encounter: { ...c.encounter, topics: [], facets: [] } }] };
    expect(composeEncounter(input).outcome).toBe('ready');
    expect(composeEncounter({ ...input, intent: { ...s.intent, requiredTopicIds: ['fixture.topic'] } }).outcome).toBe(
      'exhausted',
    );
  });
  it('only recent actual activated explanations repeat, including format siblings', () => {
    const s = withEvidence(fixture(2));
    const d = composeEncounter({
      ...s,
      evidence: {
        ...s.evidence!,
        recent: [
          {
            exposureId: 'fixture-activated',
            activatedAt: '2026-10-20T11:00:00Z',
            explanationUnitId: s.candidates[0]!.encounter.explanationUnitId,
            facets: [],
          },
        ],
      },
    });
    expect(d.evaluations[0]?.features).toMatchObject({ recentRepetition: 1, novelty: 0 });
    const old = composeEncounter({
      ...s,
      evidence: {
        ...s.evidence!,
        recent: [
          {
            exposureId: 'fixture-old',
            activatedAt: '2026-10-18T11:00:00Z',
            explanationUnitId: s.candidates[0]!.encounter.explanationUnitId,
            facets: [],
          },
        ],
      },
    });
    expect(old.evaluations[0]?.features.recentRepetition).toBe(0);
  });
  it('MMR reduces redundant explanations and uses deterministic lexical ties', () => {
    const s = fixture(4);
    const a = s.candidates[0]!;
    const candidates = s.candidates.map((c, i) =>
      i === 1
        ? {
            ...c,
            encounter: {
              ...c.encounter,
              metadata: { ...a.encounter.metadata, kind: c.encounter.kind },
              facets: a.encounter.facets,
            },
          }
        : c,
    );
    const d = composeEncounter({ ...s, candidates });
    expect(d.selection.map((c) => c.assetId)).toEqual(['asset-0', 'asset-2', 'asset-3']);
    expect(d.selection[1]!.mmr).toBeLessThan(d.selection[1]!.score);
  });
  it('horizontal requires an admitted exact source/target/link and has no exploration', () => {
    const s = fixture(2);
    const source = { assetId: 'source', assetRevision: 1 };
    const c = s.candidates[1]!;
    const input = {
      ...s,
      mode: 'horizontal' as const,
      source,
      candidates: [
        s.candidates[0]!,
        {
          ...c,
          continuity: {
            linkId: 'fixture-link',
            source,
            target: ref(c.encounter),
            direction: 'next' as const,
            strength: 1,
          },
        },
      ],
      explorationPool: [ref(c.encounter)],
    };
    const d = composeEncounter(input);
    expect(d.selection[0]?.assetId).toBe(c.encounter.assetId);
    expect(d.exploration.fraction).toBe(0);
    expect(() =>
      composeEncounter({
        ...input,
        candidates: [{ ...c, continuity: { ...input.candidates[1]!.continuity!, target: source } }],
      }),
    ).toThrow();
  });
  it('refuses contradictory evidence lineage, attribution, counts and oversized inputs', () => {
    const s = withEvidence(fixture(1));
    expect(() => composeEncounter({ ...s, evidence: { ...s.evidence!, privacyEpoch: 2 } })).toThrow();
    expect(() =>
      composeEncounter({ ...s, ...{ rawObservations: ['not permitted in a prepared snapshot'] } }),
    ).toThrow();
    expect(() =>
      composeEncounter({
        ...s,
        evidence: {
          ...s.evidence!,
          topics: [{ topicId: 'fixture.topic', activity: 1, formats: [{ kind: 'reel', measured: 0, qualified: 1 }] }],
        },
      }),
    ).toThrow();
    expect(() => composeEncounter({ ...s, candidates: Array.from({ length: 101 }, () => s.candidates[0]!) })).toThrow();
    expect(() =>
      composeEncounter({
        ...s,
        candidates: [
          {
            ...s.candidates[0]!,
            encounter: {
              ...s.candidates[0]!.encounter,
              topics: [
                { topicId: 'a', role: 'primary', weight: 0.8 },
                { topicId: 'b', role: 'supporting', weight: 0.8 },
              ],
            },
          },
        ],
      }),
    ).toThrow();
  });
  test.prop([fc.integer({ min: 0, max: 100 }), fc.string({ minLength: 1, maxLength: 80 })])(
    'repeatable seed, bounded features, exact eligibility and explanation dedupe',
    (count, seed) => {
      const s = fixture(count);
      const input = {
        ...s,
        seed,
        candidates: s.candidates.map((c, i) => ({
          ...c,
          admitted: i % 7 !== 0,
          accessible: i % 11 !== 0,
          renderable: i % 13 !== 0,
          encounter: { ...c.encounter, explanationUnitId: `unit-${String(Math.floor(i / 2))}` },
        })),
        explorationPool: s.candidates.map((c) => ref(c.encounter)),
      };
      const d = composeEncounter(input);
      expect(composeEncounter(input)).toEqual(d);
      expect(d.selection.length).toBeLessThanOrEqual(3);
      const selected = d.selection.map((r) => d.evaluations.find((e) => e.assetId === r.assetId)!);
      expect(selected.every((c) => c.eligible)).toBe(true);
      expect(new Set(selected.map((c) => c.explanationUnitId)).size).toBe(selected.length);
      for (const e of d.evaluations)
        for (const f of Object.values(e.features)) {
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1);
        }
      expect(d.exploration.selectedProbability).toBeGreaterThanOrEqual(0);
      expect(d.exploration.selectedProbability).toBeLessThanOrEqual(1);
      expect(composeEncounter({ ...input, candidates: [...input.candidates].reverse() }).selection).toEqual(
        d.selection,
      );
    },
  );
  test.prop([fc.string({ minLength: 1, maxLength: 80 })])(
    'probability is the actual ranked plus uniform exploration mixture',
    (seed) => {
      const s = fixture(5);
      const d = composeEncounter({ ...s, seed, explorationPool: s.candidates.map((c) => ref(c.encounter)) });
      const chosen = d.selection[0]!;
      const isWinner = chosen.assetId === d.exploration.rankedWinner?.assetId;
      expect(d.exploration.selectedProbability).toBeCloseTo((isWinner ? 0.9 : 0) + 0.1 / 5);
      expect(composeEncounter({ ...s, seed, explorationPool: [] }).exploration.selectedProbability).toBe(1);
    },
  );
});
