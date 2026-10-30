import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerSnapshot } from '../public.js';
import { assembleSnapshot } from './snapshot-assembly.js';
import type { EncounterSnapshot } from '../../content/public.js';

/** Labelled CI input fixtures: a vertical move from a Scroll that is Part 1 of a series. */
type Candidate = ComposerSnapshot['candidates'][number];

const SERIES = 'library.earth.seasons';

function candidate(
  name: string,
  options: {
    readonly kind?: 'reel' | 'scroll';
    readonly series?: { readonly seriesId: string; readonly seriesRevision: number; readonly part: number };
    readonly unit?: string;
    readonly topic?: string;
    readonly hidden?: boolean;
  } = {},
): Candidate {
  const kind = options.kind ?? 'scroll';
  return {
    admitted: true,
    accessible: !options.hidden,
    renderable: true,
    encounter: {
      assetId: name,
      assetRevision: 1,
      kind,
      explanationUnitId: options.unit ?? `unit-${name}`,
      metadata: { kind, title: `Fixture ${name}`, summary: '', language: 'en' },
      topics: [{ topicId: options.topic ?? 'earth.seasons', role: 'primary', weight: 1 }],
      facets: [`facet-${name}`],
      siblings: [],
      ...(options.series ? { series: options.series } : {}),
      catalogWatermark: 'fixture-catalog',
      attributionVersion: 'fixture-taxonomy',
    },
  };
}

const part = (n: number, seriesRevision = 1) => ({ seriesId: SERIES, seriesRevision, part: n });

function vertical(
  candidates: readonly Candidate[],
  intent: Partial<ComposerSnapshot['intent']> = {},
  seed = 'fixture-seed',
): ComposerSnapshot {
  return {
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt: '2026-10-30T12:00:00Z',
    seed,
    mode: 'vertical',
    intent: { language: 'en', topicIds: ['earth.seasons'], text: '', explanationUnitId: 'unit-source', ...intent },
    source: { assetId: 'source', assetRevision: 1 },
    candidates,
    // Every candidate is also in the exploration pool, so the 10% branch can pick any of them.
    explorationPool: candidates.map(({ encounter }) => ({
      assetId: encounter.assetId,
      assetRevision: encounter.assetRevision,
    })),
    watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
  };
}

const offered = (snapshot: ComposerSnapshot) => composeEncounter(snapshot).selection.map((s) => s.assetId);

describe('same_series: a vertical move is a new subject (D-131)', () => {
  // The other parts share the source's topic, so every ranking feature favours them.
  const parts = [
    candidate('part-2', { series: part(2) }),
    candidate('part-3', { series: part(3) }),
    candidate('other-revision', { series: part(2, 7) }),
  ];
  const elsewhere = candidate('tides', { topic: 'earth.tides' });

  it('never offers another part of the series, in any revision, however well it ranks', () => {
    const decision = composeEncounter(vertical([...parts, elsewhere], { currentSeriesId: SERIES }));
    expect(decision.selection.map((s) => s.assetId)).toEqual(['tides']);
    for (const name of ['part-2', 'part-3', 'other-revision'])
      expect(decision.evaluations.find((e) => e.assetId === name)).toMatchObject({
        eligible: false,
        exclusions: ['same_series'],
      });
    expect(decision.evaluations.find((e) => e.assetId === 'tides')).toMatchObject({ eligible: true, exclusions: [] });
  });

  it('without the series in the intent the same candidates are offered (an old snapshot replays unchanged)', () => {
    expect(offered(vertical([...parts, elsewhere]))).toEqual(expect.arrayContaining(['part-2']));
  });

  it('is exhausted, not a series move, when only the series is left', () => {
    expect(composeEncounter(vertical(parts, { currentSeriesId: SERIES })).outcome).toBe('exhausted');
  });

  it('keeps a different series and an unseries candidate eligible', () => {
    const decision = composeEncounter(
      vertical(
        [
          candidate('other-series', { series: { seriesId: 'library.earth.tides', seriesRevision: 1, part: 1 } }),
          elsewhere,
        ],
        {
          currentSeriesId: SERIES,
        },
      ),
    );
    expect(decision.selection.map((s) => s.assetId).sort()).toEqual(['other-series', 'tides']);
  });

  it('applies to vertical moves only: a series move still reaches the next part', () => {
    const next = candidate('part-2', { series: part(2) });
    const source = { assetId: 'source', assetRevision: 1 };
    const horizontal: ComposerSnapshot = {
      ...vertical([next], {}),
      mode: 'horizontal',
      candidates: [
        {
          ...next,
          continuity: {
            linkId: 'link',
            source,
            target: { assetId: 'part-2', assetRevision: 1 },
            direction: 'next',
            strength: 1,
          },
        },
      ],
      explorationPool: [],
    };
    expect(offered(horizontal)).toEqual(['part-2']);
    // Asking for the exclusion on a move that would ignore it is a wrong snapshot, not a silent no-op.
    expect(() =>
      composeEncounter({ ...horizontal, intent: { ...horizontal.intent, currentSeriesId: SERIES } }),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
  });

  test.prop([
    fc.array(fc.record({ inSeries: fc.boolean(), reel: fc.boolean(), hidden: fc.boolean() }), {
      minLength: 1,
      maxLength: 30,
    }),
    fc.string({ minLength: 1, maxLength: 40 }),
    fc.boolean(),
  ])('no seed, order or format ever offers a candidate of the series', (specs, seed, sticky) => {
    const candidates = specs.map((spec, index) =>
      candidate(`c-${String(index)}`, {
        kind: spec.reel ? 'reel' : 'scroll',
        hidden: spec.hidden,
        ...(spec.inSeries ? { series: part(1 + (index % 4), 1 + (index % 3)) } : {}),
      }),
    );
    const inSeries = new Set(candidates.filter((c) => c.encounter.series).map((c) => c.encounter.assetId));
    const snapshot = vertical(
      candidates,
      { currentSeriesId: SERIES, ...(sticky ? { stickyFormat: 'scroll' } : {}) },
      seed,
    );
    const decision = composeEncounter(snapshot);
    expect(decision.selection.every((s) => !inSeries.has(s.assetId))).toBe(true);
    expect(decision.exploration.pool.every((p) => !inSeries.has(p.assetId))).toBe(true);
    for (const e of decision.evaluations) expect(e.exclusions.includes('same_series')).toBe(inSeries.has(e.assetId));
  });
});

describe('sticky format: next stays in the format the person is in (D-132)', () => {
  const scrolls = [candidate('scroll-a'), candidate('scroll-b'), candidate('scroll-c')];
  const reels = [candidate('reel-a', { kind: 'reel' }), candidate('reel-b', { kind: 'reel' })];

  it('offers only the person format while any of it is eligible, and records that it kept it', () => {
    for (const preferred of ['scroll', 'reel'] as const) {
      const decision = composeEncounter(vertical([...scrolls, ...reels], { stickyFormat: preferred }));
      const kinds = new Set(
        decision.selection.map(
          (s) => decision.input.candidates.find((c) => c.encounter.assetId === s.assetId)!.encounter.kind,
        ),
      );
      expect([...kinds]).toEqual([preferred]);
      expect(decision.stickyFormat).toEqual({ preferred, outcome: 'kept' });
      const other = decision.evaluations.filter((e) =>
        e.assetId.startsWith(preferred === 'scroll' ? 'reel' : 'scroll'),
      );
      expect(other.every((e) => !e.eligible && e.exclusions.includes('format_sticky'))).toBe(true);
    }
  });

  it('falls back to the other format only when none of the person format is eligible, and records it', () => {
    // The only Reel is hidden and the other is the explanation the person is on.
    const reelsOut = [
      candidate('reel-hidden', { kind: 'reel', hidden: true }),
      candidate('reel-same', { kind: 'reel', unit: 'unit-source' }),
    ];
    const decision = composeEncounter(vertical([...reelsOut, ...scrolls], { stickyFormat: 'reel' }));
    expect(decision.selection.map((s) => s.assetId).sort()).toEqual(['scroll-a', 'scroll-b', 'scroll-c']);
    expect(decision.stickyFormat).toEqual({ preferred: 'reel', outcome: 'fell_back' });
    expect(decision.evaluations.every((e) => !e.exclusions.includes('format_sticky'))).toBe(true);
  });

  it('counts a same-series candidate as not eligible, so Part 2 cannot keep the format alive', () => {
    const decision = composeEncounter(
      vertical([candidate('part-2', { series: part(2) }), ...reels], {
        stickyFormat: 'scroll',
        currentSeriesId: SERIES,
      }),
    );
    expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
    expect(decision.selection.map((s) => s.assetId).sort()).toEqual(['reel-a', 'reel-b']);
  });

  it('is exhausted when nothing at all is eligible, and says it fell back', () => {
    const decision = composeEncounter(vertical([candidate('only', { hidden: true })], { stickyFormat: 'scroll' }));
    expect(decision.outcome).toBe('exhausted');
    expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
  });

  it('is absent from the decision when the intent names no format (today behaviour)', () => {
    const decision = composeEncounter(vertical([...scrolls, ...reels]));
    expect(decision.stickyFormat).toBeUndefined();
    expect(decision.evaluations.every((e) => !e.exclusions.includes('format_sticky'))).toBe(true);
    expect(new Set(decision.selection.map((s) => s.assetId[0])).size).toBeGreaterThan(1);
  });

  it('treats Reel and Scroll alike: the rule follows the format the person is in, not a favourite', () => {
    const mixed = [...scrolls, ...reels];
    expect(offered(vertical(mixed, { stickyFormat: 'reel' })).every((id) => id.startsWith('reel'))).toBe(true);
    expect(offered(vertical(mixed, { stickyFormat: 'scroll' })).every((id) => id.startsWith('scroll'))).toBe(true);
  });

  it('keeps the exploration branch inside the format too', () => {
    for (let n = 0; n < 60; n += 1) {
      const decision = composeEncounter(
        vertical([...scrolls, ...reels], { stickyFormat: 'reel' }, `seed-${String(n)}`),
      );
      expect(decision.selection.every((s) => s.assetId.startsWith('reel'))).toBe(true);
    }
  });

  it('refuses a format that is both required and preferred, and a preference on another move', () => {
    const base = vertical([...scrolls]);
    expect(() =>
      composeEncounter({ ...base, intent: { ...base.intent, format: 'scroll', stickyFormat: 'scroll' } }),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
    expect(() =>
      composeEncounter({ ...base, mode: 'return', intent: { ...base.intent, stickyFormat: 'scroll' } }),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
  });

  test.prop([
    fc.array(fc.record({ reel: fc.boolean(), hidden: fc.boolean(), sameUnit: fc.boolean() }), {
      minLength: 0,
      maxLength: 30,
    }),
    fc.constantFrom('reel', 'scroll'),
    fc.string({ minLength: 1, maxLength: 40 }),
  ])('stays in the format exactly when something of it is eligible', (specs, preferred, seed) => {
    const candidates = specs.map((spec, index) =>
      candidate(`c-${String(index)}`, {
        kind: spec.reel ? 'reel' : 'scroll',
        hidden: spec.hidden,
        ...(spec.sameUnit ? { unit: 'unit-source' } : {}),
      }),
    );
    const decision = composeEncounter(vertical(candidates, { stickyFormat: preferred }, seed));
    const eligibleKinds = decision.evaluations
      .filter((e) => e.eligible)
      .map((e) => candidates.find((c) => c.encounter.assetId === e.assetId)!.encounter.kind);
    const offeredKinds = decision.selection.map(
      (s) => candidates.find((c) => c.encounter.assetId === s.assetId)!.encounter.kind,
    );
    // Eligibility here is the screen before the format rule, so recompute it without the rule.
    const screened = candidates.filter((c) => c.accessible && c.encounter.explanationUnitId !== 'unit-source');
    const hasPreferred = screened.some((c) => c.encounter.kind === preferred);
    if (hasPreferred) {
      expect(offeredKinds.every((kind) => kind === preferred)).toBe(true);
      expect(eligibleKinds.every((kind) => kind === preferred)).toBe(true);
    }
    expect(decision.stickyFormat).toEqual({ preferred, outcome: hasPreferred ? 'kept' : 'fell_back' });
    if (!hasPreferred)
      expect(offeredKinds.length).toBe(Math.min(3, new Set(screened.map((c) => c.encounter.explanationUnitId)).size));
  });
});

describe('deterministic replay', () => {
  test.prop([fc.string({ minLength: 1, maxLength: 40 }), fc.constantFrom('reel', 'scroll'), fc.boolean()])(
    'the same inputs give the same decision',
    (seed, preferred, withSeries) => {
      const candidates = [
        candidate('part-2', { series: part(2) }),
        candidate('tides'),
        candidate('reel-a', { kind: 'reel' }),
        candidate('reel-b', { kind: 'reel', topic: 'space.stars' }),
      ];
      const snapshot = vertical(
        candidates,
        { stickyFormat: preferred, ...(withSeries ? { currentSeriesId: SERIES } : {}) },
        seed,
      );
      const first = composeEncounter(snapshot);
      expect(composeEncounter(structuredClone(snapshot))).toEqual(first);
      expect(JSON.stringify(composeEncounter(snapshot))).toBe(JSON.stringify(first));
      // Retrieval order does not decide: the policy sorts by score and then by identity.
      expect(composeEncounter({ ...snapshot, candidates: [...candidates].reverse() }).selection).toEqual(
        first.selection,
      );
    },
  );
});

describe('assembling the vertical rules from the source (labelled CI inputs)', () => {
  const encounter = (name: string, extra: Partial<EncounterSnapshot> = {}): EncounterSnapshot => ({
    assetId: name,
    assetRevision: 1,
    kind: 'scroll',
    explanationUnitId: `unit-${name}`,
    metadata: { kind: 'scroll', title: name, summary: '', language: 'en' },
    topics: [{ topicId: 'earth.seasons', role: 'primary', weight: 1 }],
    facets: [],
    siblings: [],
    catalogWatermark: `w-${name}`,
    attributionVersion: 'taxonomy',
    ...extra,
  });
  const input = (extra: Partial<Parameters<typeof assembleSnapshot>[0]> = {}) => ({
    universeId: 'universe',
    privacyEpoch: 1,
    evaluatedAt: '2026-10-30T12:00:00Z',
    seed: 'seed',
    mode: 'vertical' as const,
    source: encounter('source', { series: part(1) }),
    candidates: [encounter('other')],
    hiddenAssetIds: [],
    links: [],
    fallbackContextWatermark: 'unprepared:1',
    hashCatalogWatermarks: (watermarks: readonly string[]) => watermarks.join(','),
    ...extra,
  });

  it('carries the source series and the format only when the move asks for them', () => {
    expect(
      assembleSnapshot(input({ excludeSourceSeries: true, stickyFormat: 'scroll' })).snapshot.intent,
    ).toMatchObject({
      currentSeriesId: SERIES,
      stickyFormat: 'scroll',
    });
    const plain = assembleSnapshot(input()).snapshot.intent;
    expect(plain.currentSeriesId).toBeUndefined();
    expect(plain.stickyFormat).toBeUndefined();
  });

  it('names no series for a source outside one, and never on a move that is not a subject move', () => {
    const noSeries = assembleSnapshot(input({ source: encounter('source'), excludeSourceSeries: true })).snapshot;
    expect(noSeries.intent.currentSeriesId).toBeUndefined();
    const series = assembleSnapshot(
      input({ mode: 'horizontal', excludeSourceSeries: true, stickyFormat: 'scroll' }),
    ).snapshot;
    expect(series.intent.currentSeriesId).toBeUndefined();
    expect(series.intent.stickyFormat).toBeUndefined();
  });
});
