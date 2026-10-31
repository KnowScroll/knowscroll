import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerSnapshot } from '../public.js';
import { COMPOSER_POLICY_V0, COMPOSER_POLICY_V1 } from '../domain/policy.js';
import { fixtureSnapshots } from './snapshot-fixtures.js';
import {
  DEFAULT_VARIANTS,
  normaliseForReplay,
  startPolicyReplay,
  withVerticalWeights,
  type StoredDecision,
} from './replay-policy.js';

/** Labelled CI fixtures: a person on Seasons Part 1 who has read the Seasons Scrolls today. */
const SERIES = 'library.earth.seasons';
type Candidate = ComposerSnapshot['candidates'][number];

function scroll(name: string, topic: string, series?: number): Candidate {
  return {
    admitted: true,
    accessible: true,
    renderable: true,
    encounter: {
      assetId: name,
      assetRevision: 1,
      kind: 'scroll',
      explanationUnitId: `unit-${name}`,
      metadata: { kind: 'scroll', title: `Fixture ${name}`, summary: `About ${topic}.`, language: 'en' },
      topics: [{ topicId: topic, role: 'primary', weight: 1 }],
      facets: [`facet-${name}`],
      siblings: [],
      ...(series ? { series: { seriesId: SERIES, seriesRevision: 1, part: series } } : {}),
      catalogWatermark: 'fixture-catalog',
      attributionVersion: 'fixture-taxonomy',
    },
  };
}

/** The input a vertical move had before D-131 and policy v1: no series, no sticky format, no recent topics. */
function storedInput(seed: string): ComposerSnapshot {
  const candidates = [
    scroll('part-1', 'earth.seasons', 1),
    scroll('part-2', 'earth.seasons', 2),
    scroll('part-3', 'earth.seasons', 3),
    scroll('limits', 'earth.seasons'),
    scroll('tides', 'earth.tides'),
    scroll('stars', 'space.stars'),
  ];
  return {
    universeId: 'fixture-universe-private',
    privacyEpoch: 1,
    evaluatedAt: '2026-10-30T12:00:00.000Z',
    seed,
    mode: 'vertical',
    intent: { language: 'en', topicIds: ['earth.seasons'], text: '', explanationUnitId: 'unit-part-1' },
    source: { assetId: 'part-1', assetRevision: 1 },
    candidates,
    explorationPool: [],
    evidence: {
      universeId: 'fixture-universe-private',
      privacyEpoch: 1,
      evaluatedAt: '2026-10-30T12:00:00.000Z',
      watermark: 'w',
      policyVersion: 'fixture-actual-activity',
      topics: [{ topicId: 'earth.seasons', activity: 3, formats: [{ kind: 'scroll', measured: 3, qualified: 3 }] }],
      recent: [
        {
          exposureId: 'exposure-1',
          activatedAt: '2026-10-30T11:55:00.000Z',
          explanationUnitId: 'unit-part-1',
          facets: ['facet-part-1'],
        },
        {
          exposureId: 'exposure-2',
          activatedAt: '2026-10-30T11:40:00.000Z',
          explanationUnitId: 'unit-limits',
          facets: ['facet-limits'],
        },
      ],
      hiddenAssetIds: [],
    },
    watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'w' },
  };
}

const stored = (snapshot: ComposerSnapshot): StoredDecision => ({
  policyVersion: 'composer-policy.v0',
  payload: JSON.parse(JSON.stringify(composeEncounter(snapshot, COMPOSER_POLICY_V0))) as unknown,
});

describe('normaliseForReplay', () => {
  const input = storedInput('seed');
  const source = input.candidates[0]!;

  it('names the series and the format as today’s assembly would, and the topics of recent encounters', () => {
    const normalised = normaliseForReplay(input, source);
    expect(normalised.intent.currentSeriesId).toBe(SERIES);
    expect(normalised.intent.stickyFormat).toBe('scroll');
    expect(normalised.evidence?.recent.map((r) => r.topicIds)).toEqual([['earth.seasons'], ['earth.seasons']]);
  });

  it('keeps what the input already names, and leaves a recent encounter it cannot place without topics', () => {
    const named: ComposerSnapshot = {
      ...input,
      intent: { ...input.intent, currentSeriesId: 'other.series', stickyFormat: 'reel' },
      evidence: {
        ...input.evidence!,
        recent: [
          { ...input.evidence!.recent[0]!, explanationUnitId: 'unit-gone', topicIds: ['a.b'] },
          { ...input.evidence!.recent[1]!, explanationUnitId: 'unit-unknown' },
        ],
      },
    };
    const normalised = normaliseForReplay(named, source);
    expect(normalised.intent).toMatchObject({ currentSeriesId: 'other.series', stickyFormat: 'reel' });
    expect(normalised.evidence?.recent[0]?.topicIds).toEqual(['a.b']);
    expect(normalised.evidence?.recent[1]?.topicIds).toBeUndefined();
  });

  it('does not change its input', () => {
    const before = JSON.stringify(input);
    normaliseForReplay(input, source);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('startPolicyReplay', () => {
  const seeds = Array.from({ length: 12 }, (_, n) => `seed-${String(n)}`);

  it('shows the series rule and the topic change: stored offers a part, v0 stays on the topic, v1 leaves it', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for (const seed of seeds) replay.add(stored(storedInput(seed)));
    const report = replay.report();
    expect(report.read).toBe(12);
    expect(report.replayed).toBe(12);
    expect(report.storedPolicies).toEqual({ 'composer-policy.v0': 12 });
    const [served, v0, v1] = report.variants;
    expect(served?.label).toBe('stored (as served)');
    // Before D-131 the best next subject was another part of the series.
    expect(served?.firstOffer.sameSeries).toBeGreaterThan(0);
    // After it neither policy offers a part, and the replay applies the rule to the old input.
    expect(v0?.firstOffer.sameSeries).toBe(0);
    expect(v1?.firstOffer.sameSeries).toBe(0);
    // v0 still lands on the topic (the unseen "limits" Scroll); v1 leaves it.
    expect(v0?.firstOffer.sameTopic).toBeGreaterThan(v1?.firstOffer.sameTopic ?? 0);
    expect(v1?.firstOffer.subjectChanges).toBeGreaterThan(v0?.firstOffer.subjectChanges ?? 99);
    expect(v1?.shares.sameTopicFirstOffer).toBeLessThan(v0?.shares.sameTopicFirstOffer ?? 0);
    // Sticky format is on in the replay (the person is in a Scroll), and kept while a Scroll is eligible.
    expect(v1?.stickyFormat.kept).toBe(12);
  });

  it('counts a replay of the other numbers under their own label', () => {
    const variants = [
      DEFAULT_VARIANTS[0]!,
      withVerticalWeights(COMPOSER_POLICY_V1, { intent: 0.35, recentTopic: 0 }, 'v1 with the v0 numbers'),
    ];
    const replay = startPolicyReplay(variants);
    for (const seed of seeds) replay.add(stored(storedInput(seed)));
    const [, v0, other] = replay.report().variants;
    expect(other?.label).toBe('v1 with the v0 numbers');
    // Only play level, format cells and exploration differ, and this input has none of them.
    expect(other?.firstOffer).toEqual(v0?.firstOffer);
  });

  it('skips what it cannot replay and says how many, without guessing', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    const vertical = storedInput('seed');
    const noSource = stored({ ...vertical, candidates: vertical.candidates.slice(1) });
    const horizontal = fixtureSnapshots().find((s) => s.mode === 'horizontal')!;
    replay.add(noSource);
    replay.add(stored(horizontal));
    replay.add({ policyVersion: 'composer-policy.v0', payload: { selection: [], input: { nonsense: true } } });
    replay.add({ policyVersion: 'composer-policy.v0', payload: null });
    const report = replay.report();
    expect(report).toMatchObject({
      read: 4,
      replayed: 0,
      skipped: { notVertical: 1, sourceNotInCandidates: 1, unreadable: 2 },
    });
    expect(report.variants.every((v) => v.decisions === 0 && v.shares.sameTopicFirstOffer === 0)).toBe(true);
  });

  it('replays the varied fixtures without error, and names no id, title or text', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for (const snapshot of fixtureSnapshots()) replay.add(stored(snapshot));
    for (const seed of seeds) replay.add(stored(storedInput(seed)));
    const report = replay.report();
    expect(report.replayed).toBeGreaterThan(10);
    const text = JSON.stringify(report);
    for (const secret of ['fixture-universe', 'asset-', 'exposure-', 'Fixture', 'About ', 'unit-', 'facet-'])
      expect(text).not.toContain(secret);
    // Every leaf is a count or a share, except the variants' labels.
    const leaves: [string, unknown][] = [];
    const walk = (value: unknown, key: string): void => {
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, k);
        return;
      }
      leaves.push([key, value]);
    };
    walk(report, 'report');
    for (const [key, value] of leaves)
      if (typeof value === 'string') expect(key).toBe('label');
      else expect(typeof value).toBe('number');
  });
});
