import { describe, expect, it } from 'vitest';
import type { EncounterSnapshot } from '../../content/public.js';
import { SNAPSHOT_BYTE_BUDGET, assembleSnapshot, evidenceQueryFor, type SnapshotInput } from './snapshot-assembly.js';

function encounter(index: number, summaryLength = 10): EncounterSnapshot {
  return {
    assetId: `asset-${String(index)}`,
    assetRevision: 1,
    kind: 'scroll',
    explanationUnitId: `unit-${String(index)}`,
    metadata: { kind: 'scroll', title: `Title ${String(index)}`, summary: 'x'.repeat(summaryLength), language: 'en' },
    topics: [{ topicId: 'topic.a', role: 'primary', weight: 1 }],
    facets: [`facet-${String(index)}`],
    siblings: [],
    catalogWatermark: `watermark-${String(index)}`,
    attributionVersion: 'taxonomy',
  };
}

const base = (candidates: readonly EncounterSnapshot[], extra: Partial<SnapshotInput> = {}): SnapshotInput => ({
  universeId: 'universe',
  privacyEpoch: 1,
  evaluatedAt: '2026-10-20T12:00:00Z',
  seed: 'seed',
  mode: 'vertical',
  candidates,
  hiddenAssetIds: [],
  links: [],
  fallbackContextWatermark: 'unprepared:1',
  hashCatalogWatermarks: (watermarks) => `hash(${watermarks.join(',')})`,
  ...extra,
});

describe('snapshot assembly (pure, labelled CI inputs)', () => {
  it('marks hidden candidates inaccessible and names the unit to move away from', () => {
    const { snapshot, truncated } = assembleSnapshot(
      base([encounter(1), encounter(2)], { hiddenAssetIds: ['asset-2'], source: encounter(0) }),
    );
    expect(truncated).toBe(false);
    expect(snapshot.candidates.map((c) => c.accessible)).toEqual([true, false]);
    expect(snapshot.intent.explanationUnitId).toBe('unit-0');
    expect(snapshot.explorationPool).toHaveLength(2);
    expect(snapshot.watermarks.catalog).toBe('hash(watermark-1,watermark-2)');
    expect(snapshot.watermarks.context).toBe('unprepared:1');
  });

  it('drops trailing candidates, in few passes, until the input fits its durable budget', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => encounter(i, 4_000));
    let serialisations = 0;
    const original = JSON.stringify;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      serialisations += 1;
      return original(...args);
    }) as typeof JSON.stringify;
    let assembled;
    try {
      assembled = assembleSnapshot(base(candidates));
    } finally {
      JSON.stringify = original;
    }
    expect(assembled.truncated).toBe(true);
    expect(assembled.snapshot.candidates.length).toBeLessThan(100);
    expect(assembled.snapshot.candidates.length).toBeGreaterThan(0);
    expect(original(assembled.snapshot).length).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    // The first candidates are kept, in retrieval order, with a watermark and pool that match them.
    expect(assembled.snapshot.candidates[0]?.encounter.assetId).toBe('asset-0');
    expect(assembled.snapshot.explorationPool).toHaveLength(assembled.snapshot.candidates.length);
    expect(serialisations).toBeLessThan(10);
  });

  it('keeps only assessments of candidates that are still retrieved', () => {
    const entry = { relevance: 0.5, appropriateness: 0.5, redundancy: 0.5 };
    const semanticAssessments = {
      roleVersion: 'jev.1/hp2',
      model: 'fixture-model',
      assessedAt: '2026-10-20T12:00:00Z',
      expiresAt: '2026-10-20T12:30:00Z',
      entries: [
        { assetId: 'asset-1', assetRevision: 1, ...entry },
        { assetId: 'gone', assetRevision: 1, ...entry },
      ],
    };
    const kept = assembleSnapshot(base([encounter(1)], { semanticAssessments })).snapshot;
    expect(kept.semanticAssessments?.entries.map((e) => e.assetId)).toEqual(['asset-1']);
    const none = assembleSnapshot(base([encounter(2)], { semanticAssessments })).snapshot;
    expect(none.semanticAssessments).toBeUndefined();
  });

  it('builds the bounded evidence query from exactly the retrieved candidates', () => {
    const query = evidenceQueryFor([encounter(1), { ...encounter(2), explanationUnitId: 'unit-1' }], 'T');
    expect(query.candidateAssetIds).toEqual(['asset-1', 'asset-2']);
    expect(query.topicIds).toEqual(['topic.a']);
    expect(query.candidates).toEqual([{ explanationUnitId: 'unit-1', facets: ['facet-1', 'facet-2'] }]);
  });
});
