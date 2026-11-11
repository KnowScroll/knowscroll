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

  describe('the topics of the source’s system, for the `same_system` place Composer records (policy v2)', () => {
    const on = (index: number, topicId: string, role: 'primary' | 'incidental' = 'primary'): EncounterSnapshot => ({
      ...encounter(index),
      topics: [{ topicId, role, weight: 1 }],
    });

    it('names the candidates’ topics that share a catalogue system with the source, never the source’s own', () => {
      const { snapshot } = assembleSnapshot(
        base([on(1, 'earth.tides'), on(2, 'earth.seasons'), on(3, 'space.stars')], { source: on(0, 'earth.seasons') }),
      );
      expect(snapshot.intent.topicIds).toEqual(['earth.seasons']);
      expect(snapshot.intent.systemTopicIds).toEqual(['earth.tides']);
    });

    it('does not count an incidental mention of a topic, and names nothing for a source in no known system', () => {
      const { snapshot } = assembleSnapshot(
        base([on(1, 'earth.tides', 'incidental')], { source: on(0, 'earth.seasons') }),
      );
      expect(snapshot.intent.systemTopicIds).toBeUndefined();
      expect(
        assembleSnapshot(base([on(1, 'earth.tides')], { source: on(0, 'topic.unknown') })).snapshot.intent
          .systemTopicIds,
      ).toBeUndefined();
    });

    it('names none for a move without a source or for a move that is not vertical', () => {
      expect(assembleSnapshot(base([on(1, 'earth.tides')])).snapshot.intent.systemTopicIds).toBeUndefined();
      const horizontal = assembleSnapshot(
        base([on(1, 'earth.tides')], { source: on(0, 'earth.seasons'), mode: 'horizontal' }),
      );
      expect(horizontal.snapshot.intent.systemTopicIds).toBeUndefined();
    });
  });

  describe('truncation keeps the other-format reserve (policy v2 gives stickiness way to an unseen candidate of the other format)', () => {
    const kindOf = (index: number, kind: 'reel' | 'scroll'): EncounterSnapshot => {
      const long = encounter(index, 4_000);
      return { ...long, kind, metadata: { ...long.metadata, kind } };
    };
    // 80 Reels (the person's format, read first) then 20 Scrolls (the reserve, read last), far over the 180 kB budget.
    const candidates = [
      ...Array.from({ length: 80 }, (_, i) => kindOf(i, 'reel')),
      ...Array.from({ length: 20 }, (_, i) => kindOf(80 + i, 'scroll')),
    ];

    it('drops Reels, not the twenty Scrolls, when the snapshot is over budget', () => {
      const { snapshot, truncated } = assembleSnapshot(base(candidates, { stickyFormat: 'reel' }));
      expect(truncated).toBe(true);
      expect(snapshot.candidates.filter((c) => c.encounter.kind === 'scroll')).toHaveLength(20);
      expect(snapshot.candidates.length).toBeLessThan(100);
      // Retrieval order is kept: the Reels that stay are the first ones, then the Scrolls.
      expect(snapshot.candidates.map((c) => c.encounter.assetId)).toEqual(
        [
          ...candidates.filter((c) => c.kind === 'reel').slice(0, snapshot.candidates.length - 20),
          ...candidates.filter((c) => c.kind === 'scroll'),
        ].map((c) => c.assetId),
      );
      expect(snapshot.explorationPool).toHaveLength(snapshot.candidates.length);
    });

    it('without a format the person is in, the trailing candidates are dropped as before', () => {
      const { snapshot } = assembleSnapshot(base(candidates));
      expect(snapshot.candidates.filter((c) => c.encounter.kind === 'scroll').length).toBeLessThan(20);
    });

    it('protects only the first twenty of the other format; the rest are dropped like any trailing candidate', () => {
      const many = [
        ...Array.from({ length: 10 }, (_, i) => kindOf(i, 'reel')),
        ...Array.from({ length: 60 }, (_, i) => kindOf(10 + i, 'scroll')),
      ];
      const { snapshot } = assembleSnapshot(base(many, { stickyFormat: 'reel' }));
      const scrolls = snapshot.candidates.filter((c) => c.encounter.kind === 'scroll').map((c) => c.encounter.assetId);
      expect(snapshot.candidates.filter((c) => c.encounter.kind === 'reel')).toHaveLength(10);
      expect(scrolls.slice(0, 20)).toEqual(many.slice(10, 30).map((c) => c.assetId));
      expect(scrolls.length).toBeLessThan(60);
    });
  });
});
