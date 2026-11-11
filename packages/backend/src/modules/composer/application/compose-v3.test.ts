import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_POLICY_V0,
  COMPOSER_POLICY_V1,
  COMPOSER_POLICY_V2,
  COMPOSER_POLICY_V3,
  composeEncounter,
  composerPolicyFor,
  policyOf,
  validateSnapshot,
  type ComposerPolicy,
  type ComposerSnapshot,
  type PreparedEvidenceInput,
} from '../public.js';
import { fixtureSnapshots } from './snapshot-fixtures.js';

/**
 * Policy v3 (#674, slices 4.2 and 5.2, D-420): interest with shrinkage, format by hierarchical pooling, a logged format
 * exploration quota and lane-aware exploration. Labelled CI fixtures, never product data. Where a rule is new, the same
 * snapshot is shown under v2.
 */
type Candidate = ComposerSnapshot['candidates'][number];
type Evidence = NonNullable<ComposerSnapshot['evidence']>;

const SOURCE_TOPIC = 'earth.seasons';
const LOVED_SYSTEM_TOPIC = 'space.stars';
const UNKNOWN_TOPIC = 'history.industrial-revolution';

function candidate(
  name: string,
  options: {
    readonly kind?: 'reel' | 'scroll';
    readonly topic?: string;
    readonly unit?: string;
    readonly lane?: Candidate['encounter']['lane'];
    readonly readingMinutes?: number;
  } = {},
): Candidate {
  const kind = options.kind ?? 'scroll';
  return {
    admitted: true,
    accessible: true,
    renderable: true,
    encounter: {
      assetId: name,
      assetRevision: 1,
      kind,
      explanationUnitId: options.unit ?? `unit-${name}`,
      metadata: { kind, title: `Fixture ${name}`, summary: '', language: 'en' },
      topics: [{ topicId: options.topic ?? SOURCE_TOPIC, role: 'primary', weight: 1 }],
      facets: [],
      siblings: [],
      ...(options.readingMinutes === undefined
        ? {}
        : { traits: { playLevel: 'plain' as const, readingMinutes: options.readingMinutes } }),
      ...(options.lane ? { lane: options.lane } : {}),
      catalogWatermark: 'fixture-catalog',
      attributionVersion: 'fixture-taxonomy',
    },
  };
}

const rollup = (activity: number, reel: [number, number], scroll: [number, number]) => ({
  activity,
  formats: [
    { kind: 'reel' as const, measured: reel[1], qualified: reel[0] },
    { kind: 'scroll' as const, measured: scroll[1], qualified: scroll[0] },
  ],
});

interface Options {
  readonly seed?: string;
  readonly mode?: ComposerSnapshot['mode'];
  readonly intent?: Partial<ComposerSnapshot['intent']>;
  readonly evidence?: Partial<Evidence>;
  readonly met?: readonly string[];
  readonly pool?: readonly Candidate[];
}

/** A vertical move from a source on the Seasons topic, with the v3 roll-ups the caller names. */
function vertical(candidates: readonly Candidate[], options: Options = {}): ComposerSnapshot {
  const evaluatedAt = '2026-11-11T12:00:00.000Z';
  const met = options.met ?? [];
  const topicIds = [...new Set(candidates.flatMap((c) => c.encounter.topics.map((t) => t.topicId)))].sort();
  const systemOf = (id: string) => id.split('.')[0]!;
  return {
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt,
    seed: options.seed ?? 'fixture-seed',
    mode: options.mode ?? 'vertical',
    intent: {
      language: 'en',
      topicIds: [SOURCE_TOPIC],
      text: '',
      explanationUnitId: 'unit-source',
      ...options.intent,
    },
    source: { assetId: 'source', assetRevision: 1 },
    candidates,
    explorationPool: (options.pool ?? candidates).map(({ encounter }) => ({
      assetId: encounter.assetId,
      assetRevision: 1,
    })),
    evidence: {
      universeId: 'fixture-universe',
      privacyEpoch: 1,
      evaluatedAt,
      watermark: 'x',
      policyVersion: 'fixture-actual-activity',
      topics: [],
      topicSystems: topicIds.map((topicId) => ({ topicId, systemId: systemOf(topicId) })),
      recent: [],
      established: {
        policyVersion: 'retained-activated-history.v0',
        watermark: 'x',
        units: [...new Set(candidates.map((c) => c.encounter.explanationUnitId))].map((explanationUnitId) => ({
          explanationUnitId,
          encountered: met.includes(explanationUnitId),
          ...(met.includes(explanationUnitId) ? { lastEncounteredAt: '2026-11-01T10:00:00.000Z' } : {}),
          facets: [],
        })),
      },
      hiddenAssetIds: [],
      ...options.evidence,
    },
    watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
  };
}

const V2 = COMPOSER_POLICY_V2;
const V3 = COMPOSER_POLICY_V3;
/** No exploration branch of either kind, so the ranking is what a test reads. */
const ranked = (policy: ComposerPolicy): ComposerPolicy => ({
  ...policy,
  explorationFraction: 0,
  formatExplorationFraction: 0,
});
const featureOf = (snapshot: ComposerSnapshot, policy: ComposerPolicy, asset: string) =>
  composeEncounter(snapshot, ranked(policy)).evaluations.find((e) => e.assetId === asset)!.features;

describe('policy v3 is a new label that keeps every rule and number of v2', () => {
  it('is named, selectable by the setting and found by its label', () => {
    expect(V3.version).toBe('composer-policy.v3');
    expect(composerPolicyFor('v3')).toBe(V3);
    expect(composerPolicyFor('v2')).toBe(V2);
    expect(policyOf('composer-policy.v3')).toBe(V3);
    expect(composeEncounter(vertical([candidate('a')]), composerPolicyFor('v3')).policyVersion).toBe(
      'composer-policy.v3',
    );
  });

  it('changes only what interest and format read, the format exploration quota (5%) and what retrieval asks for', () => {
    const {
      version: _a,
      interestModel: _b,
      formatModel: _c,
      formatExplorationFraction: _d,
      retrieval: _e,
      interestTopK: _f,
      ...v3
    } = V3;
    const {
      version: _g,
      interestModel: _h,
      formatModel: _i,
      formatExplorationFraction: _j,
      retrieval: _k,
      interestTopK: _l,
      ...v2
    } = V2;
    expect(v3).toEqual(v2);
    expect(V3.formatExplorationFraction).toBe(0.05);
    expect(V3.retrieval).toBe('lanes');
    expect(V3.interestTopK).toBe(32);
    expect(V3.encountered).toBe('unseen-first');
    for (const old of [COMPOSER_POLICY_V0, COMPOSER_POLICY_V1, V2])
      expect([
        old.interestModel,
        old.formatModel,
        old.formatExplorationFraction,
        old.retrieval,
        old.interestTopK,
      ]).toEqual([null, null, 0, 'single', 0]);
  });

  it('with every new rule switched off decides exactly as v2 does, on every labelled fixture', () => {
    const off: ComposerPolicy = {
      ...V3,
      interestModel: null,
      formatModel: null,
      formatExplorationFraction: 0,
      retrieval: 'single',
      interestTopK: 0,
    };
    for (const snapshot of fixtureSnapshots()) {
      const old = composeEncounter(snapshot, V2);
      const now = composeEncounter(snapshot, off);
      expect({ ...now, policyVersion: old.policyVersion }).toEqual(old);
    }
  });

  it('leaves v0, v1 and v2 decisions unchanged when the input also carries v3’s roll-ups, systems and lanes', () => {
    for (const snapshot of fixtureSnapshots()) {
      const richer: ComposerSnapshot = {
        ...snapshot,
        candidates: snapshot.candidates.map((c) => ({
          ...c,
          encounter: { ...c.encounter, lane: 'continue' as const },
        })),
        ...(snapshot.evidence
          ? {
              evidence: {
                ...snapshot.evidence,
                person: rollup(9, [3, 4], [2, 5]),
                systems: [{ systemId: 'earth', ...rollup(4, [1, 2], [1, 2]) }],
                topicSystems: [{ topicId: 'earth.seasons', systemId: 'earth' }],
              },
            }
          : {}),
      };
      for (const policy of [COMPOSER_POLICY_V0, COMPOSER_POLICY_V1, V2]) {
        const plain = composeEncounter(snapshot, policy);
        const rich = composeEncounter(richer, policy);
        const { input: _plainInput, ...plainRest } = plain;
        const { input: _richInput, ...richRest } = rich;
        expect(richRest).toEqual(plainRest);
      }
    }
  });
});

describe('interest: a topic met once outscores one never met, and a loved system lifts a topic never met in it', () => {
  const known = candidate('known', { topic: SOURCE_TOPIC });
  const never = candidate('never', { topic: UNKNOWN_TOPIC });
  const lovedSiblings = candidate('loved-sibling', { topic: LOVED_SYSTEM_TOPIC });
  const topics = (rows: Evidence['topics']) => ({ topics: rows });

  it('v3 scores a topic met once above one never met; v2 scored it below', () => {
    const snapshot = vertical([known, never], {
      evidence: topics([{ topicId: SOURCE_TOPIC, activity: 0.6, formats: [] }]),
    });
    expect(featureOf(snapshot, V3, 'known').interest).toBeGreaterThan(featureOf(snapshot, V3, 'never').interest);
    expect(featureOf(snapshot, V2, 'known').interest).toBeLessThan(featureOf(snapshot, V2, 'never').interest);
  });

  it('v3 scores a never-met topic of a loved system above an unknown one; v2 cannot tell them apart', () => {
    const snapshot = vertical([lovedSiblings, never], {
      evidence: {
        ...topics([]),
        systems: [{ systemId: 'space', ...rollup(8, [2, 3], [3, 4]) }],
        person: rollup(10, [3, 4], [3, 4]),
      },
    });
    expect(featureOf(snapshot, V3, 'loved-sibling').interest).toBeGreaterThan(
      featureOf(snapshot, V3, 'never').interest,
    );
    expect(featureOf(snapshot, V2, 'loved-sibling').interest).toBe(featureOf(snapshot, V2, 'never').interest);
  });

  it('lets an old interest decay toward its system and never below an unknown topic', () => {
    const system = { systemId: 'earth', ...rollup(5, [1, 2], [1, 2]) };
    const withActivity = (activity: number) =>
      featureOf(
        vertical([known, never], {
          evidence: { ...topics([{ topicId: SOURCE_TOPIC, activity, formats: [] }]), systems: [system] },
        }),
        V3,
        'known',
      ).interest;
    const unknown = featureOf(vertical([known, never]), V3, 'never').interest;
    let previous = withActivity(3);
    for (const activity of [1, 0.3, 0.05, 0.001]) {
      const value = withActivity(activity);
      expect(value).toBeLessThan(previous);
      expect(value).toBeGreaterThanOrEqual(unknown);
      previous = value;
    }
  });

  it('is the neutral 0.5 with no history at all, as it was', () => {
    const { evidence: _evidence, ...bare } = vertical([known]);
    expect(featureOf(bare, V3, 'known').interest).toBe(0.5);
    expect(featureOf(bare, V2, 'known').interest).toBe(0.5);
  });

  it('puts the never-met topic of a loved system first when intent and format cannot tell candidates apart', () => {
    // Neither candidate is on the source's topic, so Intent is equal, and no format evidence exists.
    const snapshot = vertical([lovedSiblings, never], {
      evidence: {
        ...topics([]),
        systems: [{ systemId: 'space', ...rollup(8, [2, 3], [3, 4]) }],
        person: rollup(10, [3, 4], [3, 4]),
      },
    });
    expect(composeEncounter(snapshot, ranked(V3)).selection[0]!.assetId).toBe('loved-sibling');
  });
});

describe('format: evidence of one format in a system informs a topic never read in it', () => {
  const reel = candidate('reel', { kind: 'reel', topic: LOVED_SYSTEM_TOPIC, unit: 'unit-shared' });
  const scroll = candidate('scroll', { kind: 'scroll', topic: LOVED_SYSTEM_TOPIC });
  // The person qualified 9 of 10 Reels and 1 of 10 Scrolls across the space system; this topic has no row.
  const evidence: Partial<Evidence> = {
    topics: [],
    systems: [{ systemId: 'space', ...rollup(8, [9, 10], [1, 10]) }],
    person: rollup(8, [9, 10], [1, 10]),
  };

  it('v3 prefers the format the system’s evidence favours; v2 reads one uniform prior for both', () => {
    const snapshot = vertical([reel, scroll], { evidence });
    expect(featureOf(snapshot, V3, 'reel').format).toBeGreaterThan(featureOf(snapshot, V3, 'scroll').format + 0.2);
    expect(featureOf(snapshot, V2, 'reel').format).toBe(featureOf(snapshot, V2, 'scroll').format);
  });

  it('is the global prior with nothing known, and prefers neither format at a cold start whatever the durations', () => {
    const scrolls = [0.5, 1.5, 5, 12].map((minutes) =>
      candidate(`scroll-${String(minutes)}`, { topic: LOVED_SYSTEM_TOPIC, readingMinutes: minutes }),
    );
    const snapshot = vertical([reel, ...scrolls], { evidence: { topics: [] } });
    for (const asset of ['reel', ...scrolls.map((s) => s.encounter.assetId)])
      expect(featureOf(snapshot, V3, asset).format).toBe(0.5);
  });

  it('reads the duration bucket of the prior, so a table measured later can tell a short read from a long one, and evidence outweighs it', () => {
    const tilted: ComposerPolicy = {
      ...V3,
      formatModel: { ...V3.formatModel!, prior: { short: 0.6, medium: 0.5, long: 0.4 } },
    };
    const short = candidate('short', { topic: LOVED_SYSTEM_TOPIC, readingMinutes: 1 });
    const long = candidate('long', { topic: LOVED_SYSTEM_TOPIC, readingMinutes: 12 });
    const snapshot = vertical([short, long], { evidence: { topics: [] } });
    expect(featureOf(snapshot, tilted, 'short').format).toBeCloseTo(0.6, 12);
    expect(featureOf(snapshot, tilted, 'long').format).toBeCloseTo(0.4, 12);
    const learned = vertical([short, long], {
      evidence: {
        topics: [],
        systems: [{ systemId: 'space', ...rollup(8, [0, 0], [20, 20]) }],
        person: rollup(8, [0, 0], [20, 20]),
      },
    });
    // Twenty qualified Scrolls leave both above 0.8 and the gap the prior made (0.20) under a quarter of it.
    expect(featureOf(learned, tilted, 'long').format).toBeGreaterThan(0.8);
    const gap = featureOf(learned, tilted, 'short').format - featureOf(learned, tilted, 'long').format;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.05);
  });
});

describe('format exploration: a logged share of system-chosen first offers draws from the format the person is not in', () => {
  const SEEDS = 3000;
  /** The person is in Scrolls. Two unseen Scrolls and one unseen Reel; stickiness would never offer the Reel. */
  const scrolls = [candidate('scroll-a'), candidate('scroll-b', { topic: UNKNOWN_TOPIC })];
  const reelOther = candidate('reel-x', { kind: 'reel', topic: UNKNOWN_TOPIC });
  const move = (seed: string, extra: Options = {}) =>
    vertical([...scrolls, reelOther], { seed, intent: { stickyFormat: 'scroll', ...extra.intent }, ...extra });

  const decisions = Array.from({ length: SEEDS }, (_, n) => composeEncounter(move(`seed-${String(n)}`), V3));
  const drawn = decisions.filter((d) => d.formatExploration?.branch === 'other_format');

  it('draws about 5% of moves, and every draw offers the other format first, unseen', () => {
    const share = drawn.length / SEEDS;
    expect(share).toBeGreaterThan(0.035);
    expect(share).toBeLessThan(0.065);
    for (const decision of drawn) {
      expect(decision.selection[0]!.assetId).toBe('reel-x');
      expect(decision.formatExploration).toEqual({
        fraction: 0.05,
        branch: 'other_format',
        personFormat: 'scroll',
        propensity: 0.05,
      });
      expect(decision.exploration.selectedProbability).toBe(0.05);
      expect(decision.exploration.branch).toBe('ranked');
      expect(decision.outcome).toBe('ready');
    }
  });

  it('records the branch not drawn with its propensity, and the first offer’s overall propensity carries it', () => {
    const kept = decisions.filter((d) => d.formatExploration?.branch === 'person_format');
    expect(kept.length + drawn.length).toBe(SEEDS);
    for (const decision of kept) {
      expect(decision.formatExploration).toEqual({
        fraction: 0.05,
        branch: 'person_format',
        personFormat: 'scroll',
        propensity: 0.95,
      });
      // The first offer is in the person's format and was reached with probability 0.95 times its probability within the branch.
      expect(decision.selection[0]!.assetId).not.toBe('reel-x');
      const within = decision.exploration.selectedProbability / 0.95;
      expect(within).toBeGreaterThan(0);
      expect(within).toBeLessThanOrEqual(1);
    }
  });

  it('is a propensity that sums to one over the first offers of the two branches', () => {
    // With the within-branch exploration off, the person's-format branch offers one first item with 0.95 and the draw one with 0.05.
    const noEpsilon: ComposerPolicy = { ...V3, explorationFraction: 0 };
    const firsts = new Map<string, number>();
    for (let n = 0; n < 400; n += 1) {
      const decision = composeEncounter(move(`mass-${String(n)}`), noEpsilon);
      firsts.set(decision.selection[0]!.assetId, decision.exploration.selectedProbability);
    }
    expect([...firsts.values()].reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 12);
  });

  it('replays: the decision names v3 and recomputes to the same bytes', () => {
    for (const decision of decisions.slice(0, 200)) {
      expect(composeEncounter(decision.input, policyOf(decision.policyVersion))).toEqual(decision);
    }
  });

  it('draws with its own generator, so the exploration draw of the same decision is what it was without it', () => {
    const noFormat: ComposerPolicy = { ...V3, formatExplorationFraction: 0 };
    for (let n = 0; n < 200; n += 1) {
      const seed = `own-${String(n)}`;
      const with_ = composeEncounter(move(seed), V3);
      const without = composeEncounter(move(seed), noFormat);
      if (with_.formatExploration?.branch === 'person_format') {
        expect(with_.selection.map((s) => s.assetId)).toEqual(without.selection.map((s) => s.assetId));
        expect(with_.exploration.branch).toBe(without.exploration.branch);
      }
    }
  });

  it('never draws against an explicit format request, a move the person asked for, or a policy without it', () => {
    const none = (decision: ReturnType<typeof composeEncounter>) => expect(decision.formatExploration).toBeUndefined();
    for (let n = 0; n < 300; n += 1) {
      const seed = `no-${String(n)}`;
      // A required format (an explicit switch) and no stickiness: the other format is hard-excluded.
      none(composeEncounter(vertical([...scrolls, reelOther], { seed, intent: { format: 'scroll' } }), V3));
      // A variant (explicit format), a return and a series move are the person's own and are never system-chosen.
      none(
        composeEncounter(
          vertical([candidate('v', { unit: 'unit-source' }), reelOther], {
            seed,
            mode: 'variant',
            intent: { format: 'reel', explanationUnitId: 'unit-source' },
          }),
          V3,
        ),
      );
      none(
        composeEncounter(
          vertical([...scrolls, reelOther], {
            seed,
            intent: { stickyFormat: 'scroll', exactTarget: { assetId: 'scroll-a', assetRevision: 1 } },
          }),
          V3,
        ),
      );
      // A policy without the quota.
      none(composeEncounter(move(seed), V2));
    }
  });

  it('does not draw when stickiness gave way (nothing of the person’s format is eligible) or there is no other format to offer', () => {
    const onlyReels = vertical([reelOther], { intent: { stickyFormat: 'scroll' } });
    expect(composeEncounter(onlyReels, V3).formatExploration).toBeUndefined();
    expect(composeEncounter(onlyReels, V3).stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
    const onlyScrolls = vertical(scrolls, { intent: { stickyFormat: 'scroll' } });
    expect(composeEncounter(onlyScrolls, V3).formatExploration).toBeUndefined();
  });

  it('only ever offers an unseen explanation from the other format: a met Reel is not drawn', () => {
    const metReel = candidate('reel-met', { kind: 'reel', topic: UNKNOWN_TOPIC });
    for (let n = 0; n < 400; n += 1) {
      const decision = composeEncounter(
        vertical([...scrolls, metReel], {
          seed: `met-${String(n)}`,
          intent: { stickyFormat: 'scroll' },
          met: ['unit-reel-met'],
        }),
        V3,
      );
      // The met Reel is excluded as already met, so there is no other-format candidate to draw from.
      expect(decision.formatExploration).toBeUndefined();
      expect(decision.selection.map((s) => s.assetId)).not.toContain('reel-met');
    }
  });

  test.prop([fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }), fc.string({ minLength: 1, maxLength: 12 })])(
    'never offers a met explanation first while an unseen one is eligible, drawn or not',
    (metFlags, seed) => {
      const pool = [
        candidate('p0'),
        candidate('p1', { topic: UNKNOWN_TOPIC }),
        candidate('p2', { kind: 'reel', topic: UNKNOWN_TOPIC }),
        candidate('p3', { kind: 'reel' }),
        candidate('p4', { topic: LOVED_SYSTEM_TOPIC }),
        candidate('p5', { kind: 'reel', topic: LOVED_SYSTEM_TOPIC }),
      ];
      const met = pool.filter((_, i) => metFlags[i]).map((c) => c.encounter.explanationUnitId);
      const decision = composeEncounter(
        vertical(pool, { seed: `prop-${seed}`, intent: { stickyFormat: 'scroll' }, met }),
        V3,
      );
      const unseenExists = pool.some((c) => !met.includes(c.encounter.explanationUnitId));
      if (unseenExists && decision.selection.length > 0)
        for (const offer of decision.selection) {
          const unit = pool.find((c) => c.encounter.assetId === offer.assetId)!.encounter.explanationUnitId;
          expect(met).not.toContain(unit);
        }
    },
  );
});

describe('exploration draws from the explore lane (a sample stratified by system), and still draws when none of it is eligible', () => {
  const lane = (name: string, lane: Candidate['encounter']['lane'], topic: string) => candidate(name, { lane, topic });
  const candidates = [
    lane('source-1', 'source', SOURCE_TOPIC),
    lane('continue-1', 'continue', LOVED_SYSTEM_TOPIC),
    lane('explore-1', 'explore', UNKNOWN_TOPIC),
    lane('explore-2', 'explore', 'computing.browsers'),
  ];
  const explored = (snapshot: ComposerSnapshot, seed: number) =>
    composeEncounter(
      { ...snapshot, seed: `lane-${String(seed)}` },
      { ...V3, formatExplorationFraction: 0, explorationFraction: 1 },
    );

  it('pools exactly the snapshot’s pool among the eligible', () => {
    const snapshot = vertical(candidates, { pool: candidates.filter((c) => c.encounter.lane === 'explore') });
    for (let n = 0; n < 60; n += 1) {
      const decision = explored(snapshot, n);
      expect(decision.exploration.branch).toBe('explore');
      expect(['explore-1', 'explore-2']).toContain(decision.selection[0]!.assetId);
      expect(decision.exploration.pool.map((p) => p.assetId)).toEqual(['explore-1', 'explore-2']);
    }
  });

  it('falls back to every eligible candidate when none of the pool is eligible, instead of going silent', () => {
    const snapshot = vertical(candidates, {
      pool: candidates.filter((c) => c.encounter.lane === 'explore'),
      met: ['unit-explore-1', 'unit-explore-2'],
    });
    const decision = explored(snapshot, 1);
    expect(decision.exploration.pool.map((p) => p.assetId).sort()).toEqual(['continue-1', 'source-1']);
    expect(decision.exploration.branch).toBe('explore');
  });

  it('v2 keeps the pool of the snapshot as it is: an empty pool among the eligible stays empty', () => {
    const snapshot = vertical(candidates, {
      pool: candidates.filter((c) => c.encounter.lane === 'explore'),
      met: ['unit-explore-1', 'unit-explore-2'],
    });
    const decision = composeEncounter(snapshot, { ...V2, explorationFraction: 1 });
    expect(decision.exploration.pool).toEqual([]);
    expect(decision.exploration.fraction).toBe(0);
  });
});

describe('the v3 snapshot input is checked at the trust boundary', () => {
  const base = () =>
    vertical([candidate('a', { lane: 'continue' })], {
      evidence: {
        topics: [],
        person: rollup(3, [1, 2], [1, 2]),
        systems: [{ systemId: 'earth', ...rollup(2, [1, 1], [0, 1]) }],
      },
    });

  it('accepts lanes, roll-ups and topic systems', () => {
    expect(() => validateSnapshot(base())).not.toThrow();
  });

  it('refuses a roll-up with more qualified than measured encounters, a repeated system or topic, and an unknown lane', () => {
    const at = (evidence: Partial<PreparedEvidenceInput>) => ({
      ...base(),
      evidence: { ...base().evidence!, ...evidence },
    });
    expect(() => validateSnapshot(at({ person: rollup(1, [3, 2], [0, 0]) }))).toThrow('COMPOSER_SNAPSHOT_INVALID');
    expect(() =>
      validateSnapshot(
        at({
          systems: [
            { systemId: 'earth', ...rollup(1, [0, 0], [0, 0]) },
            { systemId: 'earth', ...rollup(1, [0, 0], [0, 0]) },
          ],
        }),
      ),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
    expect(() =>
      validateSnapshot(
        at({
          topicSystems: [
            { topicId: 'earth.seasons', systemId: 'earth' },
            { topicId: 'earth.seasons', systemId: 'earth' },
          ],
        }),
      ),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
    const unknownLane = base();
    expect(() =>
      validateSnapshot({
        ...unknownLane,
        candidates: [
          {
            ...unknownLane.candidates[0]!,
            encounter: { ...unknownLane.candidates[0]!.encounter, lane: 'invented' as never },
          },
        ],
      }),
    ).toThrow('COMPOSER_SNAPSHOT_INVALID');
  });
});
