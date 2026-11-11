import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerSnapshot } from '../public.js';
import { COMPOSER_POLICY_V0, COMPOSER_POLICY_V1, COMPOSER_POLICY_V2 } from '../domain/policy.js';
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
      // No format evidence on purpose: with three qualified Scrolls on Seasons the topic's Format fit keeps it ahead
      // under v1 too (a legitimate per-topic signal), and this fixture must show a case where v1 leaves the topic.
      topics: [{ topicId: 'earth.seasons', activity: 3, formats: [] }],
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

  it('names the topics of the source’s system as today’s assembly does, for the `same_system` place', () => {
    // Seasons and Tides are both Earth topics; Stars is a Space topic. The source's own topic is the first step.
    expect(normaliseForReplay(input, source).intent.systemTopicIds).toEqual(['earth.tides']);
  });

  it('keeps the system topics an input already names', () => {
    const named: ComposerSnapshot = { ...input, intent: { ...input.intent, systemTopicIds: ['space.stars'] } };
    expect(normaliseForReplay(named, source).intent.systemTopicIds).toEqual(['space.stars']);
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

describe('new content: repeats, already met, tiers and places (#674)', () => {
  const seeds = Array.from({ length: 12 }, (_, n) => `seed-${String(n)}`);
  const asHistory = (snapshot: ComposerSnapshot): ComposerSnapshot => {
    const units = [...new Set(snapshot.candidates.map((c) => c.encounter.explanationUnitId))];
    return {
      ...snapshot,
      evidence: {
        ...snapshot.evidence!,
        established: {
          policyVersion: 'retained-activated-history.v0',
          watermark: 'w',
          units: units.map((explanationUnitId) => ({
            explanationUnitId,
            // The person has met the Seasons Scrolls and Tides; Stars is new.
            encountered: explanationUnitId !== 'unit-stars',
            facets: [],
          })),
        },
      },
    };
  };

  it('compares v0, v1 and v2 by default, v2 last', () => {
    expect(DEFAULT_VARIANTS.map((v) => v.label)).toEqual([
      'composer-policy.v0',
      'composer-policy.v1',
      'composer-policy.v2',
    ]);
  });

  it('shows v2 giving the unseen Scroll where the stored decisions and v0 and v1 gave one the person had met', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for (const seed of seeds) replay.add(stored(asHistory(storedInput(seed))));
    const report = replay.report();
    expect(report.replayedWithHistory).toBe(12);
    const [served, v0, v1, v2] = report.variants;
    for (const variant of [served!, v0!, v1!, v2!]) expect(variant.newContent.firstOffers).toBe(12);
    // v0 takes a met Seasons Scroll (the soft penalty never outweighs the topic); v1 leaves the topic here; v2 offers only
    // what is new whatever the weights say.
    expect(v0!.newContent.alreadyMetFirstOffer).toBeGreaterThan(0);
    expect(served!.newContent.alreadyMetFirstOffer).toBeGreaterThan(0);
    expect(v2).toMatchObject({
      label: 'composer-policy.v2',
      newContent: { alreadyMetFirstOffer: 0, alreadyMetAllOffers: 0 },
      shares: { unseenFirstOffer: 1, alreadyMetFirstOffer: 0, alreadyMetAllOffers: 0 },
    });
    expect(v0!.shares.unseenFirstOffer).toBeLessThan(1);
    expect(v2!.newContent.tiers).toEqual({ unseen: 12, last_resort: 0 });
    expect(v2!.newContent.places).toEqual({ source_topic: 0, same_system: 0, elsewhere: 12 });
  });

  it('counts the repeats of one person’s first offers, and none across people', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for (const seed of seeds) replay.add(stored(asHistory(storedInput(seed))));
    const [, , , v2] = replay.report().variants;
    // Twelve decisions of one person, each offering Stars first: eleven repeat the first.
    expect(v2!.newContent.repeatedFirstOffer).toBe(11);
    expect(v2!.shares.repeatFirstOffer).toBe(0.917);

    const other = startPolicyReplay(DEFAULT_VARIANTS);
    for (const [index, seed] of seeds.entries()) {
      const input = asHistory(storedInput(seed));
      other.add(
        stored({
          ...input,
          universeId: `person-${String(index)}`,
          evidence: { ...input.evidence!, universeId: `person-${String(index)}` },
        }),
      );
    }
    expect(other.report().variants[3]!.newContent.repeatedFirstOffer).toBe(0);
  });

  it('puts each first offer in a tier and a place for every policy alike, each summing to the first offers', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for (const seed of seeds) replay.add(stored(asHistory(storedInput(seed))));
    for (const variant of replay.report().variants) {
      const { tiers, places, firstOffers } = variant.newContent;
      expect(tiers.unseen + tiers.last_resort).toBe(firstOffers);
      expect(Object.values(places).reduce((sum, n) => sum + n, 0)).toBe(firstOffers);
      // The place `source_topic` is the existing same-topic count: one definition, split three ways.
      expect(places.source_topic).toBe(variant.firstOffer.sameTopic);
    }
    // v0's first offer is a met Seasons Scroll: its tier is the last resort, which is how repeats show in the tier counts.
    expect(replay.report().variants[1]!.newContent.tiers.last_resort).toBeGreaterThan(0);
  });

  it('keeps the topic movement D-190 measured: on the fixtures v2 leaves the topic about as often as v1', () => {
    // No history, so nothing is met and v2 differs from v1 only in its tie-break and the way it draws exploration.
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    const noHistory = (snapshot: ComposerSnapshot): ComposerSnapshot =>
      snapshot.evidence ? { ...snapshot, evidence: { ...snapshot.evidence, recent: [] } } : snapshot;
    for (const snapshot of fixtureSnapshots()) replay.add(stored(noHistory(snapshot)));
    for (const seed of seeds) replay.add(stored(noHistory(storedInput(seed))));
    const [, , v1, v2] = replay.report().variants;
    expect(v1!.decisions).toBeGreaterThan(20);
    expect(v2!.decisions).toBe(v1!.decisions);
    expect(Math.abs(v2!.shares.sameTopicFirstOffer - v1!.shares.sameTopicFirstOffer)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(v2!.shares.sameTopicAllOffers - v1!.shares.sameTopicAllOffers)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(v2!.shares.subjectChangeFirstOffer - v1!.shares.subjectChangeFirstOffer)).toBeLessThanOrEqual(0.1);
    expect(v2!.newContent.alreadyMetFirstOffer).toBe(0);
  });

  it('counts an input without retained history as history-less, and everything in it as unseen', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for (const seed of seeds) replay.add(stored(storedInput(seed)));
    expect(replay.report().replayedWithHistory).toBe(0);
  });

  it('replays a stored v2 decision under every policy too, and names no id', () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    replay.add({
      policyVersion: 'composer-policy.v2',
      payload: JSON.parse(
        JSON.stringify(composeEncounter(asHistory(storedInput('seed')), COMPOSER_POLICY_V2)),
      ) as unknown,
    });
    const report = replay.report();
    expect(report.storedPolicies).toEqual({ 'composer-policy.v2': 1 });
    expect(report.variants).toHaveLength(4);
    expect(JSON.stringify(report)).not.toContain('person');
  });
});
