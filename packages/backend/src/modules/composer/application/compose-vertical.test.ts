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
    /** Format twins of this candidate, by asset id. */
    readonly twins?: readonly { readonly assetId: string; readonly kind: 'reel' | 'scroll' }[];
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
      siblings: (options.twins ?? []).map((twin) => ({ ...twin, assetRevision: 1 })),
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

  it('also excludes the format twin of another part: a Reel of Part 2 is still Part 2', () => {
    const reelOfPart2 = candidate('reel-part-2', { kind: 'reel', unit: 'unit-part-2' });
    const reelElsewhere = candidate('reel-stars', { kind: 'reel', topic: 'space.stars' });
    const snapshot = vertical([parts[0]!, reelOfPart2, reelElsewhere], {
      currentSeriesId: SERIES,
      stickyFormat: 'scroll',
    });
    const decision = composeEncounter(snapshot);
    expect(decision.evaluations.find((e) => e.assetId === 'reel-part-2')).toMatchObject({
      eligible: false,
      exclusions: ['same_series'],
    });
    // No Scroll is eligible, so the format falls back, and only the Reel of another topic is offered.
    expect(decision.selection.map((s) => s.assetId)).toEqual(['reel-stars']);
    expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
    expect(composeEncounter(vertical([parts[0]!, reelOfPart2], { currentSeriesId: SERIES })).outcome).toBe('exhausted');
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

describe('related_target: another perspective is not a new subject (D-136)', () => {
  // The Related tab of the Seasons thread reaches seasons-limits; it shares the planet, so it ranks first.
  const limits = candidate('seasons-limits');
  const parts = [candidate('part-2', { series: part(2) }), candidate('part-3', { series: part(3) })];
  const elsewhere = candidate('tides', { topic: 'earth.tides' });
  const related = { currentSeriesId: SERIES, relatedAssetIds: ['seasons-limits'] };

  it('never offers the related target while anything else is eligible, and records it', () => {
    const decision = composeEncounter(vertical([limits, ...parts, elsewhere], related));
    expect(decision.selection.map((s) => s.assetId)).toEqual(['tides']);
    expect(decision.evaluations.find((e) => e.assetId === 'seasons-limits')).toMatchObject({
      eligible: false,
      exclusions: ['related_target'],
    });
    expect(decision.relatedTarget).toEqual({ outcome: 'applied', matched: 1 });
  });

  it('would have offered it without the rule: the target leads on the topic of the thread', () => {
    const without = composeEncounter(vertical([limits, ...parts, elsewhere], { currentSeriesId: SERIES }));
    expect(without.selection[0]?.assetId).toBe('seasons-limits');
    expect(without.relatedTarget).toBeUndefined();
  });

  it('also excludes the format twin of the target, in either format', () => {
    const twin = candidate('limits-reel', {
      kind: 'reel',
      unit: 'unit-seasons-limits',
      twins: [{ assetId: 'seasons-limits', kind: 'scroll' }],
    });
    const decision = composeEncounter(vertical([twin, elsewhere], related));
    expect(decision.selection.map((s) => s.assetId)).toEqual(['tides']);
    expect(decision.evaluations.find((e) => e.assetId === 'limits-reel')?.exclusions).toEqual(['related_target']);
  });

  it('steps aside when excluding would leave nothing, offers the target and records the fall back', () => {
    const decision = composeEncounter(vertical([limits, ...parts], related));
    expect(decision.selection.map((s) => s.assetId)).toEqual(['seasons-limits']);
    expect(decision.relatedTarget).toEqual({ outcome: 'fell_back', matched: 1 });
    expect(decision.evaluations.every((e) => !e.exclusions.includes('related_target'))).toBe(true);
    // The series stays out even then: it is a hard rule.
    expect(decision.evaluations.find((e) => e.assetId === 'part-2')?.exclusions).toEqual(['same_series']);
  });

  it('ranks a new topic in the other format ahead of the related target in the same format', () => {
    const reel = candidate('reel-a', { kind: 'reel', topic: 'space.stars' });
    const decision = composeEncounter(vertical([limits, reel], { ...related, stickyFormat: 'scroll' }));
    expect(decision.selection.map((s) => s.assetId)).toEqual(['reel-a']);
    expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
    expect(decision.relatedTarget).toEqual({ outcome: 'applied', matched: 1 });
  });

  it('records an applied rule that matched nothing eligible, and names nothing when no target is given', () => {
    const hidden = candidate('seasons-limits', { hidden: true });
    expect(composeEncounter(vertical([hidden, elsewhere], related)).relatedTarget).toEqual({
      outcome: 'applied',
      matched: 0,
    });
    expect(composeEncounter(vertical([limits, elsewhere], { relatedAssetIds: [] })).relatedTarget).toBeUndefined();
  });

  it('is asked of vertical moves only', () => {
    const base = vertical([elsewhere]);
    expect(() =>
      composeEncounter({ ...base, mode: 'return', intent: { ...base.intent, relatedAssetIds: ['seasons-limits'] } }),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
  });

  test.prop([
    fc.array(fc.record({ target: fc.boolean(), reel: fc.boolean(), hidden: fc.boolean() }), {
      minLength: 0,
      maxLength: 30,
    }),
    fc.string({ minLength: 1, maxLength: 40 }),
    fc.constantFrom('reel', 'scroll', undefined),
  ])('offers a related target only when nothing else is eligible, and then says so', (specs, seed, sticky) => {
    const name = (index: number) => `c-${String(index)}`;
    const candidates = specs.map((spec, index) =>
      candidate(name(index), { kind: spec.reel ? 'reel' : 'scroll', hidden: spec.hidden }),
    );
    const targets = specs.flatMap((spec, index) => (spec.target ? [name(index)] : []));
    const decision = composeEncounter(
      vertical(candidates, { relatedAssetIds: targets, ...(sticky ? { stickyFormat: sticky } : {}) }, seed),
    );
    const open = specs.flatMap((spec, index) => (spec.hidden ? [] : [{ id: name(index), target: spec.target }]));
    const offered = new Set(decision.selection.map((s) => s.assetId));
    if (targets.length === 0) {
      expect(decision.relatedTarget).toBeUndefined();
    } else if (open.some((entry) => !entry.target)) {
      expect(open.filter((entry) => entry.target && offered.has(entry.id))).toEqual([]);
      expect(decision.relatedTarget?.outcome).toBe('applied');
    } else if (open.length > 0) {
      expect(decision.relatedTarget).toEqual({ outcome: 'fell_back', matched: open.length });
      expect(decision.selection.length).toBeGreaterThan(0);
    }
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
        {
          stickyFormat: preferred,
          relatedAssetIds: ['tides'],
          ...(withSeries ? { currentSeriesId: SERIES } : {}),
        },
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

  it('a Reel takes the series of its Scroll twin, and next leaves that series in the Reel format too', () => {
    const asReel = (name: string, unit: string, extra: Partial<EncounterSnapshot> = {}): EncounterSnapshot =>
      encounter(name, {
        kind: 'reel',
        explanationUnitId: unit,
        metadata: { kind: 'reel', title: name, summary: '', language: 'en' },
        ...extra,
      });
    const reelOfPart1 = asReel('reel-part-1', 'unit-part-1');
    const candidates = [
      encounter('part-1', { series: part(1), explanationUnitId: 'unit-part-1' }),
      encounter('part-2', { series: part(2) }),
      asReel('reel-part-2', 'unit-part-2'),
      asReel('reel-stars', 'unit-stars', { topics: [{ topicId: 'space.stars', role: 'primary', weight: 1 }] }),
    ];
    const { snapshot } = assembleSnapshot(
      input({ source: reelOfPart1, candidates, excludeSourceSeries: true, stickyFormat: 'reel' }),
    );
    expect(snapshot.intent).toMatchObject({ currentSeriesId: SERIES, stickyFormat: 'reel' });
    const decision = composeEncounter(snapshot);
    expect(decision.selection.map((selected) => selected.assetId)).toEqual(['reel-stars']);
    for (const name of ['part-2', 'reel-part-2'])
      expect(decision.evaluations.find((e) => e.assetId === name)?.exclusions).toContain('same_series');
    // A Reel whose Scroll twin is not among the candidates names no series.
    expect(
      assembleSnapshot(input({ source: reelOfPart1, candidates: candidates.slice(1), excludeSourceSeries: true }))
        .snapshot.intent.currentSeriesId,
    ).toBeUndefined();
  });

  it('carries the related assets only on a subject move and only when there are some', () => {
    expect(assembleSnapshot(input({ relatedAssetIds: ['limits'] })).snapshot.intent.relatedAssetIds).toEqual([
      'limits',
    ]);
    expect(assembleSnapshot(input({ relatedAssetIds: [] })).snapshot.intent.relatedAssetIds).toBeUndefined();
    expect(
      assembleSnapshot(input({ mode: 'horizontal', relatedAssetIds: ['limits'] })).snapshot.intent.relatedAssetIds,
    ).toBeUndefined();
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
