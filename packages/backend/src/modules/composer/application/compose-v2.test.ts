import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_POLICY_V0,
  COMPOSER_POLICY_V1,
  COMPOSER_POLICY_V2,
  composeEncounter,
  composerPolicyFor,
  policyOf,
  validateSnapshot,
  type ComposerPolicy,
  type ComposerSnapshot,
} from '../public.js';
import { isMet, lastMetAt, ladderStepOf, systemTopicIdsOf, unseenStepOf } from '../domain/encountered.js';
import { tieHash } from '../domain/policy.js';
import { fixtureSnapshots } from './snapshot-fixtures.js';

/**
 * Policy v2 (#674, D-408): a person always gets new content. Labelled CI fixtures, never product data. Each rule is
 * shown beside the old rule (v1) on the same snapshot, so a test that passes under v2 fails under v1 where the rule is new.
 */
type Candidate = ComposerSnapshot['candidates'][number];

const SOURCE_TOPIC = 'earth.seasons';
const SAME_SYSTEM_TOPIC = 'earth.tides';
const OTHER_TOPIC = 'space.stars';

function candidate(
  name: string,
  options: {
    readonly kind?: 'reel' | 'scroll';
    readonly topic?: string;
    readonly unit?: string;
    readonly role?: 'primary' | 'supporting' | 'incidental';
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
      topics: [{ topicId: options.topic ?? SOURCE_TOPIC, role: options.role ?? 'primary', weight: 1 }],
      facets: [],
      siblings: [],
      catalogWatermark: 'fixture-catalog',
      attributionVersion: 'fixture-taxonomy',
    },
  };
}

interface Met {
  /** Explanation units the person has met, with when (absent: the input does not say). */
  readonly [unit: string]: string | null;
}

/** A vertical move from a source on the Seasons topic; `met` is the person's retained history for the candidates' units. */
function vertical(
  candidates: readonly Candidate[],
  options: {
    readonly met?: Met;
    readonly intent?: Partial<ComposerSnapshot['intent']>;
    readonly seed?: string;
    readonly mode?: ComposerSnapshot['mode'];
    readonly recent?: readonly string[];
  } = {},
): ComposerSnapshot {
  const units = [...new Set(candidates.map((c) => c.encounter.explanationUnitId))];
  const met = options.met ?? {};
  const evaluatedAt = '2026-11-11T12:00:00.000Z';
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
      systemTopicIds: [SAME_SYSTEM_TOPIC],
      ...options.intent,
    },
    source: { assetId: 'source', assetRevision: 1 },
    candidates,
    explorationPool: candidates.map(({ encounter }) => ({ assetId: encounter.assetId, assetRevision: 1 })),
    evidence: {
      universeId: 'fixture-universe',
      privacyEpoch: 1,
      evaluatedAt,
      watermark: 'x',
      policyVersion: 'fixture-actual-activity',
      topics: [],
      recent: (options.recent ?? []).map((unit, n) => ({
        exposureId: `exposure-${String(n)}`,
        activatedAt: new Date(Date.parse(evaluatedAt) - (n + 1) * 600_000).toISOString(),
        explanationUnitId: unit,
        facets: [],
      })),
      established: {
        policyVersion: 'retained-activated-history.v0',
        watermark: 'x',
        units: units.map((explanationUnitId) => ({
          explanationUnitId,
          encountered: explanationUnitId in met,
          ...(met[explanationUnitId] ? { lastEncounteredAt: met[explanationUnitId] } : {}),
          facets: [],
        })),
      },
      hiddenAssetIds: [],
    },
    watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
  };
}

/** No exploration branch, so the ranking is what a test reads. */
const ranked = (policy: ComposerPolicy): ComposerPolicy => ({ ...policy, explorationFraction: 0 });
const V1 = ranked(COMPOSER_POLICY_V1);
const V2 = ranked(COMPOSER_POLICY_V2);
const offered = (snapshot: ComposerSnapshot, policy: ComposerPolicy = V2) =>
  composeEncounter(snapshot, policy).selection.map((s) => s.assetId);

describe('policy v2 is a new label with the rules of #674 and the numbers of v1', () => {
  it('is named, selectable by the setting and found by its label', () => {
    expect(COMPOSER_POLICY_V2.version).toBe('composer-policy.v2');
    expect(composerPolicyFor('v2')).toBe(COMPOSER_POLICY_V2);
    expect(composerPolicyFor('v1')).toBe(COMPOSER_POLICY_V1);
    expect(composerPolicyFor('v0')).toBe(COMPOSER_POLICY_V0);
    expect(policyOf('composer-policy.v2')).toBe(COMPOSER_POLICY_V2);
    const snapshot = vertical([candidate('a')]);
    expect(composeEncounter(snapshot, composerPolicyFor('v2')).policyVersion).toBe('composer-policy.v2');
  });

  it('keeps every number of v1 and changes only the rules', () => {
    const { version: _v1, ...v1 } = COMPOSER_POLICY_V1;
    const { version: _v2, ...v2 } = COMPOSER_POLICY_V2;
    expect({ ...v2, explorationDraw: v1.explorationDraw, tieBreak: v1.tieBreak, encountered: v1.encountered }).toEqual(
      v1,
    );
    expect([COMPOSER_POLICY_V2.explorationDraw, COMPOSER_POLICY_V2.tieBreak, COMPOSER_POLICY_V2.encountered]).toEqual([
      'by-fraction',
      'seeded-hash',
      'ladder',
    ]);
    // v0 and v1 keep the literal draw, the lexical tie-break and the soft novelty term they were stored with.
    for (const old of [COMPOSER_POLICY_V0, COMPOSER_POLICY_V1])
      expect([old.explorationDraw, old.tieBreak, old.encountered]).toEqual(['one-in-ten', 'lexical', 'score']);
  });
});

describe('an explanation the person has met is not offered while something unseen is eligible', () => {
  // The met Scroll is on the source's topic, so every ranking feature favours it over the unseen one on another topic.
  const met = candidate('met', { unit: 'unit-met' });
  const unseen = candidate('unseen', { topic: OTHER_TOPIC });
  const snapshot = vertical([met, unseen], { met: { 'unit-met': '2026-11-01T10:00:00.000Z' } });

  it('leaves the met one out and says why, and records the ladder', () => {
    const decision = composeEncounter(snapshot, V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['unseen']);
    expect(decision.evaluations.find((e) => e.assetId === 'met')).toMatchObject({
      eligible: false,
      exclusions: ['already_encountered'],
    });
    expect(decision.unseenLadder).toEqual({
      outcome: 'unseen',
      step: 'any_unseen',
      offerSteps: ['any_unseen'],
      eligible: { source_topic: 0, same_system: 0, any_unseen: 1, last_resort: 0 },
    });
  });

  it('the old rule offers it first (a soft penalty that the topic match outweighs)', () => {
    expect(offered(snapshot, V1)).toContain('met');
    expect(offered(snapshot, V1)[0]).toBe('met');
    expect(composeEncounter(snapshot, V1).unseenLadder).toBeUndefined();
  });

  it('counts a recent encounter as met even where the retained history did not list its unit', () => {
    const recentOnly = vertical([met, unseen], { recent: ['unit-met'] });
    expect(offered(recentOnly)).toEqual(['unseen']);
  });

  it('treats a person with no history as having met nothing: absence asserts nothing', () => {
    const { evidence: _evidence, ...bare } = snapshot;
    expect(offered(bare).sort()).toEqual(['met', 'unseen']);
    expect(isMet(bare, 'unit-met')).toBe(false);
  });

  it('a Reel and its Scroll twin are one explanation: meeting one meets the other', () => {
    const scroll = candidate('twin-scroll', { unit: 'unit-twin' });
    const reel = candidate('twin-reel', { kind: 'reel', unit: 'unit-twin' });
    const decision = composeEncounter(vertical([scroll, reel, unseen], { met: { 'unit-twin': null } }), V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['unseen']);
    for (const name of ['twin-scroll', 'twin-reel'])
      expect(decision.evaluations.find((e) => e.assetId === name)?.exclusions).toContain('already_encountered');
  });

  it('runs before the related and format rules, so they only choose among what is new', () => {
    // The only unseen candidate is the thread's related target. The old rule drops it and offers the met one.
    const related = candidate('related', { topic: OTHER_TOPIC });
    const other = candidate('other-met', { topic: OTHER_TOPIC, unit: 'unit-other-met' });
    const withRelated = vertical([related, other], {
      met: { 'unit-other-met': '2026-11-01T10:00:00.000Z' },
      intent: { relatedAssetIds: ['related'] },
    });
    const v2 = composeEncounter(withRelated, V2);
    expect(v2.selection.map((s) => s.assetId)).toEqual(['related']);
    expect(v2.relatedTarget).toEqual({ outcome: 'fell_back', matched: 1 });
    expect(offered(withRelated, V1)).toEqual(['other-met']);
  });
});

describe('the ladder: the topic the move starts from, then its system, then anywhere', () => {
  // Names are chosen so that the old lexical tie-break would put the far one before the near one.
  const far = candidate('a-far', { topic: OTHER_TOPIC });
  const near = candidate('b-near', { topic: SAME_SYSTEM_TOPIC });
  const topic = candidate('c-topic', { topic: SOURCE_TOPIC });
  const snapshot = vertical([far, near, topic]);

  it('offers the steps in order and records each offer’s step and how many were eligible at each', () => {
    const decision = composeEncounter(snapshot, V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['c-topic', 'b-near', 'a-far']);
    expect(decision.unseenLadder).toEqual({
      outcome: 'unseen',
      step: 'source_topic',
      offerSteps: ['source_topic', 'same_system', 'any_unseen'],
      eligible: { source_topic: 1, same_system: 1, any_unseen: 1, last_resort: 0 },
    });
  });

  it('puts the same system before anywhere even where the old tie-break puts anywhere first', () => {
    expect(offered(snapshot, V1)).toEqual(['c-topic', 'a-far', 'b-near']);
  });

  it('takes the next step when the topic has nothing unseen left, and anywhere when the system has none', () => {
    const topicMet = vertical([far, near, topic], { met: { 'unit-c-topic': null } });
    expect(composeEncounter(topicMet, V2).unseenLadder).toMatchObject({ step: 'same_system' });
    expect(offered(topicMet)).toEqual(['b-near', 'a-far']);
    const systemMet = vertical([far, near, topic], { met: { 'unit-c-topic': null, 'unit-b-near': null } });
    expect(composeEncounter(systemMet, V2).unseenLadder).toMatchObject({ step: 'any_unseen' });
    expect(offered(systemMet)).toEqual(['a-far']);
  });

  it('never counts an incidental mention as being on the topic', () => {
    const incidental = candidate('incidental', { topic: SOURCE_TOPIC, role: 'incidental' });
    expect(unseenStepOf(vertical([incidental]), incidental)).toBe('any_unseen');
  });

  it('a move with no source has no topic and no system: everything unseen is anywhere', () => {
    const noSource = vertical([far, topic], { intent: { topicIds: [] } });
    const { systemTopicIds: _systemTopicIds, ...intent } = noSource.intent;
    const decision = composeEncounter({ ...noSource, intent }, V2);
    expect(decision.unseenLadder).toMatchObject({ step: 'any_unseen', eligible: { any_unseen: 2 } });
  });

  it('a person who has met everything in the topic is offered something unseen from elsewhere', () => {
    const topicA = candidate('topic-a');
    const topicB = candidate('topic-b');
    const met = { 'unit-topic-a': null, 'unit-topic-b': null };
    const decision = composeEncounter(vertical([topicA, topicB, far], { met }), V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['a-far']);
    expect(decision.outcome).toBe('ready');
    // The old rule goes back to the topic: the met Scrolls match it.
    expect(offered(vertical([topicA, topicB, far], { met }), V1)[0]).toBe('topic-a');
  });
});

describe('format stickiness gives way before a repeat is offered (D-132 and #674)', () => {
  const reelA = candidate('reel-a', { kind: 'reel', unit: 'unit-reel-a' });
  const reelB = candidate('reel-b', { kind: 'reel', unit: 'unit-reel-b' });
  const scroll = candidate('scroll-unseen', { topic: OTHER_TOPIC });

  it('a Reel watcher who has met every Reel gets an unseen Scroll', () => {
    const snapshot = vertical([reelA, reelB, scroll], {
      intent: { stickyFormat: 'reel' },
      met: { 'unit-reel-a': null, 'unit-reel-b': null },
    });
    const decision = composeEncounter(snapshot, V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['scroll-unseen']);
    expect(decision.stickyFormat).toEqual({ preferred: 'reel', outcome: 'fell_back' });
    expect(decision.unseenLadder).toMatchObject({ outcome: 'unseen' });
    // The old rule stays in Reels and repeats one the person has met.
    const old = composeEncounter(snapshot, V1);
    expect(old.selection.map((s) => s.assetId).sort()).toEqual(['reel-a', 'reel-b']);
    expect(old.stickyFormat).toEqual({ preferred: 'reel', outcome: 'kept' });
  });

  it('keeps the format while an unseen one of it exists, and leaves the other format out', () => {
    const snapshot = vertical([reelA, reelB, scroll], {
      intent: { stickyFormat: 'reel' },
      met: { 'unit-reel-a': null },
    });
    const decision = composeEncounter(snapshot, V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['reel-b']);
    expect(decision.stickyFormat).toEqual({ preferred: 'reel', outcome: 'kept' });
    expect(decision.evaluations.find((e) => e.assetId === 'scroll-unseen')?.exclusions).toEqual(['format_sticky']);
  });

  it('prefers the topic among the other format once stickiness has given way', () => {
    const near = candidate('near-scroll', { topic: SAME_SYSTEM_TOPIC });
    const snapshot = vertical([reelA, scroll, near], {
      intent: { stickyFormat: 'reel' },
      met: { 'unit-reel-a': null },
    });
    expect(offered(snapshot)).toEqual(['near-scroll', 'scroll-unseen']);
  });
});

describe('the last resort: nothing unseen in either format', () => {
  const a = candidate('a', { unit: 'unit-a' });
  const b = candidate('b', { unit: 'unit-b' });
  const c = candidate('c', { unit: 'unit-c' });
  const met = {
    'unit-a': '2026-11-10T09:00:00.000Z',
    'unit-b': '2026-10-01T09:00:00.000Z',
    'unit-c': '2026-10-20T09:00:00.000Z',
  };
  const snapshot = vertical([a, b, c], { met });

  it('offers the least recently met first, and records that it fell back', () => {
    const decision = composeEncounter(snapshot, V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['b', 'c', 'a']);
    expect(decision.outcome).toBe('ready');
    expect(decision.unseenLadder).toEqual({
      outcome: 'fell_back',
      step: 'last_resort',
      offerSteps: ['last_resort', 'last_resort', 'last_resort'],
      eligible: { source_topic: 0, same_system: 0, any_unseen: 0, last_resort: 3 },
    });
    expect(decision.evaluations.every((e) => e.eligible && e.exclusions.length === 0)).toBe(true);
    // The old rule offers the best score, whenever it was met.
    expect(offered(snapshot, V1)).toEqual(['a', 'b', 'c']);
  });

  it('puts one whose time is not recorded before every dated one: the input cannot say it is recent', () => {
    const undated = vertical([a, b, c], { met: { ...met, 'unit-c': null } });
    expect(offered(undated)[0]).toBe('c');
    expect(lastMetAt(undated, 'unit-c')).toBe(0);
  });

  it('reads the newest of the retained time and the recent encounters', () => {
    const recent = vertical([a, b, c], { met, recent: ['unit-b'] });
    expect(lastMetAt(recent, 'unit-b')).toBe(Date.parse('2026-11-11T11:50:00.000Z'));
    expect(offered(recent)).toEqual(['c', 'a', 'b']);
  });

  it('draws no exploration: its pool is the unseen, and there are none', () => {
    const decision = composeEncounter(snapshot, { ...COMPOSER_POLICY_V2, explorationFraction: 1 });
    expect(decision.exploration).toMatchObject({ fraction: 0, branch: 'ranked', pool: [] });
    expect(decision.selection[0]?.assetId).toBe('b');
  });

  it('is exhausted, not a repeat, when nothing at all is eligible', () => {
    const none = composeEncounter(vertical([candidate('source-twin', { unit: 'unit-source' })]), V2);
    expect(none.outcome).toBe('exhausted');
    expect(none.unseenLadder).toEqual({
      outcome: 'none',
      offerSteps: [],
      eligible: { source_topic: 0, same_system: 0, any_unseen: 0, last_resort: 0 },
    });
  });

  it('never offers the explanation the person is on, even as a last resort', () => {
    const onScreen = candidate('on-screen', { unit: 'unit-source' });
    const decision = composeEncounter(vertical([onScreen, a], { met: { 'unit-a': null, 'unit-source': null } }), V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['a']);
    expect(decision.evaluations.find((e) => e.assetId === 'on-screen')?.exclusions).toEqual(['current_explanation']);
  });
});

describe('what the person asked for is not a repeat (every other move is exempt)', () => {
  const metUnit = { 'unit-met': '2026-11-01T10:00:00.000Z' };
  const metCandidate = candidate('met', { unit: 'unit-met' });
  const ref = { assetId: 'met', assetRevision: 1 };

  /** The same history, on the move the person asked for. None of them asks the ladder. */
  it.each([
    [
      'a return to an exact target',
      vertical([metCandidate], {
        mode: 'return',
        met: metUnit,
        intent: { exactTarget: ref, explanationUnitId: undefined, systemTopicIds: undefined },
      }),
    ],
    [
      'a variant, the other format of what the person is on',
      vertical([candidate('met', { kind: 'reel', unit: 'unit-source' })], {
        mode: 'variant',
        met: { 'unit-source': '2026-11-01T10:00:00.000Z' },
        intent: { format: 'reel', systemTopicIds: undefined },
      }),
    ],
    [
      'a series or related step along an admitted link',
      {
        ...vertical([{ ...metCandidate }], { mode: 'horizontal', met: metUnit, intent: { systemTopicIds: undefined } }),
        candidates: [
          {
            ...metCandidate,
            continuity: {
              linkId: 'link-1',
              source: { assetId: 'source', assetRevision: 1 },
              target: ref,
              direction: 'next' as const,
              strength: 0.8,
            },
          },
        ],
      },
    ],
    [
      'a vertical move that names its target (a region opened on one encounter)',
      vertical([metCandidate], { met: metUnit, intent: { exactTarget: ref, systemTopicIds: undefined } }),
    ],
  ])('%s still offers an explanation the person has met', (_name, snapshot) => {
    const clean = JSON.parse(JSON.stringify(snapshot)) as ComposerSnapshot;
    const decision = composeEncounter(clean, V2);
    expect(decision.selection.map((s) => s.assetId)).toEqual(['met']);
    expect(decision.evaluations[0]?.exclusions).toEqual([]);
    expect(decision.unseenLadder).toBeUndefined();
  });

  it('whereas the same history on a system-chosen vertical move leaves it out for something unseen', () => {
    const decision = composeEncounter(
      vertical([metCandidate, candidate('unseen', { topic: OTHER_TOPIC })], { met: metUnit }),
      V2,
    );
    expect(decision.selection.map((s) => s.assetId)).toEqual(['unseen']);
  });

  it('a snapshot that asks for the ladder’s system topics on another move is refused, not silently ignored', () => {
    const horizontal = {
      ...vertical([metCandidate], { mode: 'horizontal' }),
      candidates: [
        {
          ...metCandidate,
          continuity: {
            linkId: 'link-1',
            source: { assetId: 'source', assetRevision: 1 },
            target: ref,
            direction: 'next' as const,
            strength: 0.8,
          },
        },
      ],
    };
    expect(() => validateSnapshot(horizontal)).toThrow('COMPOSER_SNAPSHOT_INVALID');
  });
});

describe('exploration draws only the unseen, at the fraction the policy holds', () => {
  const unseenA = candidate('unseen-a', { topic: OTHER_TOPIC });
  const unseenB = candidate('unseen-b', { topic: SAME_SYSTEM_TOPIC });
  const metOne = candidate('met-one', { unit: 'unit-met-one' });
  const metTwo = candidate('met-two', { unit: 'unit-met-two' });
  const met = { 'unit-met-one': null, 'unit-met-two': null };

  it('has a pool of the unseen eligible candidates only, and every pick is one of them', () => {
    const everyOffer = new Set<string>();
    for (let n = 0; n < 60; n += 1) {
      const decision = composeEncounter(
        vertical([unseenA, unseenB, metOne, metTwo], { met, seed: `seed-${String(n)}` }),
        { ...COMPOSER_POLICY_V2, explorationFraction: 1 },
      );
      expect(decision.exploration.pool.map((p) => p.assetId).sort()).toEqual(['unseen-a', 'unseen-b']);
      expect(decision.exploration.branch).toBe('explore');
      for (const offer of decision.selection) everyOffer.add(offer.assetId);
    }
    expect([...everyOffer].sort()).toEqual(['unseen-a', 'unseen-b']);
  });

  it('the old pool holds the met ones too, and so can explore to a repeat', () => {
    const decision = composeEncounter(vertical([unseenA, unseenB, metOne, metTwo], { met }), COMPOSER_POLICY_V1);
    expect(decision.exploration.pool.map((p) => p.assetId)).toContain('met-one');
  });

  it('reads the fraction from the policy: a fraction of one half explores about half the time', () => {
    const rate = (policy: ComposerPolicy) => {
      let explored = 0;
      for (let n = 0; n < 400; n += 1)
        if (
          composeEncounter(vertical([unseenA, unseenB], { seed: `seed-${String(n)}` }), policy).exploration.branch ===
          'explore'
        )
          explored += 1;
      return explored / 400;
    };
    const half = rate({ ...COMPOSER_POLICY_V2, explorationFraction: 0.5 });
    expect(half).toBeGreaterThan(0.42);
    expect(half).toBeLessThan(0.58);
    expect(rate(COMPOSER_POLICY_V2)).toBeLessThan(0.16);
    // v1 keeps its literal one in ten, whatever the object says (a stored v1 decision replays as it was drawn).
    expect(rate({ ...COMPOSER_POLICY_V1, explorationFraction: 0.5 })).toBeLessThan(0.16);
  });

  it('logs the realised probability from the fraction it drew with', () => {
    const decision = composeEncounter(vertical([unseenA, unseenB]), {
      ...COMPOSER_POLICY_V2,
      explorationFraction: 0.5,
    });
    const { fraction, branch, selectedProbability, rankedWinner } = decision.exploration;
    expect(fraction).toBe(0.5);
    const first = decision.selection[0]!.assetId;
    // The ranked winner has 0.5 of the mass plus its half of the exploration; the other offer only its half of it.
    expect(selectedProbability).toBe(first === rankedWinner?.assetId ? 0.5 + 0.25 : 0.25);
    expect(['ranked', 'explore']).toContain(branch);
  });
});

describe('equal scores are told apart by a hash of the seed and the asset, not by the asset id', () => {
  const x = candidate('a', { topic: OTHER_TOPIC });
  const y = candidate('b', { topic: OTHER_TOPIC });
  const winnerFor = (seed: string, policy: ComposerPolicy) =>
    composeEncounter(vertical([x, y], { seed }), policy).selection[0]!.assetId;
  const seeds = Array.from({ length: 40 }, (_, n) => `seed-${String(n)}`);

  it('the old order always puts the lower asset id first', () => {
    expect(new Set(seeds.map((seed) => winnerFor(seed, V1)))).toEqual(new Set(['a']));
  });

  it('v2 falls differently for different seeds, and the same way for the same seed', () => {
    const winners = new Set(seeds.map((seed) => winnerFor(seed, V2)));
    expect(winners).toEqual(new Set(['a', 'b']));
    for (const seed of seeds) expect(winnerFor(seed, V2)).toBe(winnerFor(seed, V2));
  });

  it('the hash depends on both the seed and the asset, and is a 32-bit number', () => {
    expect(tieHash('seed', 'a')).toBe(tieHash('seed', 'a'));
    expect(tieHash('seed', 'a')).not.toBe(tieHash('seed', 'b'));
    expect(tieHash('seed', 'a')).not.toBe(tieHash('other', 'a'));
    expect(tieHash('seed', 'a')).toBeGreaterThanOrEqual(0);
    expect(tieHash('seed', 'a')).toBeLessThan(2 ** 32);
  });
});

describe('the system topics of the ladder are named once, from what the catalogue says, and sorted', () => {
  const systemOf = (id: string) => ({ 'earth.seasons': 'earth', 'earth.tides': 'earth', 'space.stars': 'space' })[id];

  it('lists the candidates’ topics of a system the source is in, not the source’s own', () => {
    expect(
      systemTopicIdsOf(['earth.seasons'], ['space.stars', 'earth.tides', 'earth.seasons', 'earth.tides'], systemOf),
    ).toEqual(['earth.tides']);
  });

  it('is empty when the source has no topics or the catalogue does not know them', () => {
    expect(systemTopicIdsOf([], ['earth.tides'], systemOf)).toEqual([]);
    expect(systemTopicIdsOf(['unknown.topic'], ['earth.tides'], systemOf)).toEqual([]);
  });

  it('is bounded', () => {
    const many = Array.from({ length: 300 }, (_, n) => `earth.t${String(n).padStart(3, '0')}`);
    expect(systemTopicIdsOf(['earth.seasons'], many, () => 'earth', 200)).toHaveLength(200);
  });
});

describe('over the labelled fixtures', () => {
  /** Marks the units of every third candidate as met, so the fixtures exercise the rule. */
  function withHistory(snapshot: ComposerSnapshot): ComposerSnapshot {
    const units = [...new Set(snapshot.candidates.map((c) => c.encounter.explanationUnitId))];
    const metUnits = units.filter((_unit, n) => n % 3 === 0);
    if (!snapshot.evidence) return snapshot;
    return {
      ...snapshot,
      evidence: {
        ...snapshot.evidence,
        established: {
          policyVersion: 'retained-activated-history.v0',
          watermark: snapshot.evidence.watermark,
          units: units.map((explanationUnitId) => ({
            explanationUnitId,
            encountered: metUnits.includes(explanationUnitId),
            facets: [],
          })),
        },
      },
    };
  }

  const snapshots = fixtureSnapshots().map(withHistory);

  it('never offers a met explanation on a system-chosen move while an eligible unseen one exists, under any seed', () => {
    let checked = 0;
    for (const snapshot of snapshots)
      for (const seed of ['one', 'two', 'three']) {
        const input = { ...snapshot, seed };
        const decision = composeEncounter(input, COMPOSER_POLICY_V2);
        if (input.mode !== 'vertical' || input.intent.exactTarget) continue;
        const unseenEligible = decision.evaluations.filter((e) => e.eligible && !isMet(input, e.explanationUnitId));
        if (unseenEligible.length === 0) continue;
        checked += 1;
        for (const offer of decision.selection) {
          const unit = input.candidates.find((c) => c.encounter.assetId === offer.assetId)!.encounter.explanationUnitId;
          expect(isMet(input, unit)).toBe(false);
        }
      }
    expect(checked).toBeGreaterThan(20);
  });

  it('every v2 decision replays from its own input and names its label', () => {
    for (const snapshot of snapshots) {
      const decision = composeEncounter(snapshot, COMPOSER_POLICY_V2);
      expect(decision.policyVersion).toBe('composer-policy.v2');
      expect(JSON.stringify(composeEncounter(decision.input, policyOf(decision.policyVersion)))).toBe(
        JSON.stringify(decision),
      );
    }
  });

  it('records a ladder only on a system-chosen vertical move', () => {
    for (const snapshot of snapshots) {
      const decision = composeEncounter(snapshot, COMPOSER_POLICY_V2);
      const asked = snapshot.mode === 'vertical' && snapshot.intent.exactTarget === undefined;
      expect(decision.unseenLadder !== undefined).toBe(asked);
    }
  });

  test.prop([fc.integer({ min: 0, max: 59 }), fc.string({ minLength: 1, maxLength: 24 })])(
    'the step of an offer is the step of its candidate, and the steps are in order unless the ladder fell back',
    (index, seed) => {
      const input = { ...snapshots[index]!, seed };
      const decision = composeEncounter(input, COMPOSER_POLICY_V2);
      const ladder = decision.unseenLadder;
      if (ladder === undefined) return;
      const order = ['source_topic', 'same_system', 'any_unseen', 'last_resort'];
      const steps = decision.selection.map((offer) =>
        ladderStepOf(
          input,
          input.candidates.find((c) => c.encounter.assetId === offer.assetId)!,
        ),
      );
      expect(ladder.offerSteps).toEqual(steps);
      // Offers 2 and 3 never come from an earlier step than the best the ranking could take; the explore pick is the
      // only first offer allowed to sit further down, so the rest are in order.
      const rest = steps.slice(1).map((step) => order.indexOf(step));
      expect([...rest].sort((a, b) => a - b)).toEqual(rest);
    },
  );
});

describe('v0 and v1 are untouched by the new inputs and rules (their stored decisions replay byte for byte)', () => {
  /** Retained history for every third unit of the fixture, optionally with the time each was last met. */
  function withHistory(snapshot: ComposerSnapshot, timed: boolean): ComposerSnapshot {
    if (snapshot.mode !== 'vertical' || !snapshot.evidence) return snapshot;
    const units = [...new Set(snapshot.candidates.map((c) => c.encounter.explanationUnitId))];
    return {
      ...snapshot,
      ...(timed ? { intent: { ...snapshot.intent, systemTopicIds: ['earth.tides', 'space.stars'] } } : {}),
      evidence: {
        ...snapshot.evidence,
        established: {
          policyVersion: 'retained-activated-history.v0',
          watermark: snapshot.evidence.watermark,
          units: units.map((explanationUnitId, n) => ({
            explanationUnitId,
            encountered: n % 3 === 0,
            ...(timed && n % 3 === 0 ? { lastEncounteredAt: '2026-10-01T00:00:00.000Z' } : {}),
            facets: [],
          })),
        },
      },
    };
  }

  it.each([COMPOSER_POLICY_V0, COMPOSER_POLICY_V1])(
    '%s ignores the system topics and the times last met, and records no ladder',
    (policy) => {
      for (const snapshot of fixtureSnapshots()) {
        const before = composeEncounter(withHistory(snapshot, false), policy);
        const after = composeEncounter(withHistory(snapshot, true), policy);
        const { input: _after, ...rest } = after;
        const { input: _before, ...expected } = before;
        expect(rest).toEqual(expected);
        expect(after.unseenLadder).toBeUndefined();
        expect(after.evaluations.some((e) => e.exclusions.includes('already_encountered'))).toBe(false);
      }
    },
  );

  it.each([COMPOSER_POLICY_V0, COMPOSER_POLICY_V1])('%s still offers an explanation the person has met', (policy) => {
    const met = candidate('met');
    const snapshot = vertical([met, candidate('unseen', { topic: OTHER_TOPIC })], { met: { 'unit-met': null } });
    expect(composeEncounter(snapshot, ranked(policy)).selection.map((s) => s.assetId)).toContain('met');
  });
});
