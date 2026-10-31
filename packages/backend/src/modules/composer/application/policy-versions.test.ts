import { createHash } from 'node:crypto';
import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { composeEncounter, type ComposerDecision, type ComposerSnapshot } from '../public.js';
import { decideValidated, validateSnapshot } from './compose.js';
import { features, formatFitOf, recentTopicRepeat, score } from '../domain/features.js';
import { COMPOSER_POLICY_V0, COMPOSER_POLICY_V1, composerPolicyFor, policyOf } from '../domain/policy.js';
import { explorationShare } from '../domain/exploration.js';
import { fixtureSnapshots } from './snapshot-fixtures.js';

/** Same canonical form as the decision store hashes and compares. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const sha = (decision: ComposerDecision) => createHash('sha256').update(canonical(decision)).digest('hex');

/**
 * SHA-256 of the canonical decision that the code of 9b6466eb (before policy v1) made for each labelled
 * fixture snapshot. They are frozen: a change to any of them means a stored `composer-policy.v0` decision
 * would no longer replay byte for byte, which `persistComposerDecision` refuses.
 */
const V0_DECISION_HASHES = [
  'b00fc32d6d1d88baec4196d1935b6df9946b5cbe86de74101761c863eed4a16b',
  '3f6815ff6f75064c21b329e9d130ba32bb3bb61d4bbf69eb6c5c5e9c3611b75f',
  'f7656033e6518de94e4c91cb20b12fad1110be8ef718983b1593c096ecff80dd',
  '44c49dc85a1601fa5b810b8a71ca8bcd16940064eef9063616857b45cf89f3ac',
  '8d41a8b9f7c217550dfc94cffbc621dccda10da7fcce39babd2e4de52b37d7ee',
  '1a247b8c4b604749a6fdf65e7bb7694ff9305249e3bbe7de3cb791508d59c706',
  '46e931fe620080ccd33af37d14d5baf0291f49d91aa240d7405d2a86fc83816e',
  '072047441962959743d3244c20da9688b83e41f907470578c7bccd824a82c2fd',
  '80a3b4a78a9ed31fd51c903cdc4cd6e65c5c7e2a97f32c65aa8d9e4d5be81472',
  '1a687cb536cd7e9f1e48efac74d0e5d8ec0c6b6692e225fd116d25faa306b581',
  '53d7c014960a47e4490a9b6112d8b015ec9252aea6f50c8e048fd19789a1695c',
  'ccd281281ec26f4bdb227761762a21bd0a9495b666a2671cc133ae9cff3c1630',
  '52aaed32d4c0e0313c299f2a3ec15e749a86731b334c42beadae679f80571d05',
  '3a05b5f4d56820d01e0eb19e7417df4df8b2f829d18ea4f1ab1ad3c3356dd9be',
  '8482fd5dc4d037226372d9d323f001d299b05a4eb2646e8704ce92b8f0980849',
  '2d36d8f24895474e195fd241fa2380daec4b295892dc400e676f9471666490a0',
  '20a25abf850b1e3e3a2ef09f04d41750d4bbefd86d27128b25a9fbcd57913ffa',
  'a8f28eb520e1fce0fe91be43982b4a87ca2239a6a9f021bae584a06dc2e5b027',
  'ac8422812715b230c97549b74cf18db42fca2d7e925fa33793068c98263f9fd8',
  'db4f681a5a8570ea5b11122cd25719ef753df3d174033c37a946d848e8c3974f',
  '71adc1e51b16590e6e14276a3aedf4e314a3ec8a837f9751377d62d2834dd7a0',
  '67f4fd7a8ee2132ad1ae785a254de95e89f1b9897d46919996f925132a40627e',
  '3d326921f2ee0aa87fccf666cfebfd718af64f14e5c07848780654d5cd90c7d4',
  '94bda11d434c96a1559ec81e595a6c6acb830ab7a4aeff0286f3d52659754cfd',
  '95e49bd590ae74f6d02c9bea262aff6bd95faeb3a03274cafb5e0d40d0f0fe59',
  'e1eb2e1bd66654f82e98cbf6ecb43aee5e1c8dafe3967561a804113d59b12b2a',
  '9a34a82eb4ebb878bc6da2ce36a80a7b75e2316f9e4d0ee7ab87497c19ac4ae2',
  '8b150cbb603b68be678340e53fe7c97f0834ee19c1d3d5f9f2c0319d8e3901bf',
  'f32a69ef55b59679499ae4d8c99ec761346c662d7f27c1f35ab476a8fcd4e6b6',
  '85938b5eab3184385a969f15e11d2710708321730945d71839e85b38de68cc03',
  'e5aa621e7e50cdcc78feaa4db8ba5f47609ad4c0b623c579bf8ae52c48eb8018',
  '2a06fad78372de4ca4b993f0b7c33e2d5bdd4eb5bd69b5c66fdd75a1a2dad573',
  '80b7ee137e0c9e17fb4331b1aac60fa042606fcf87e7fb94fd72ebdb8ab920d4',
  'cbdcac2c537ef56521f4fa26e5b114a918f79bacd4a6f716270587ecce4dfcca',
  '5a382e2898b16fa1bb9f02d2698a08dd2faeb7ef84faa0f01b67d9e270f27f73',
  '7989b0909a98ccf26b8619329ec476a0c8d3d434717aece5e1a538f077731e7e',
  '749f594d51bbbb77871825bc707514fd4bd8c38e3f322f3ca19885a51eee00be',
  '850e9e65ad41f952dfbbb78047346c0050f79739a7e1fc21e16e867719d3b15d',
  '39b9be85872ce36ad28964326163006eedb7a2b632b7ab9e46c8bd9f62ceab69',
  'f5738f6414017307cc0e3bae8bd0cadaed58035b37bb66bae471b0e498f4486d',
  'c494122dc8c7f460babf36b17e372f6d0eeda6fb10d4adf440582e8196a7d299',
  '3c0056a6aa17bc3aef2c037084c410e6724c81796f9bbc82cfd6e40b5aeac8a4',
  'f2f5185af0e2c4213eeb6402665b00a3cfd00e9824bc200a160c2b8a2795ad30',
  'edf940f7967a2935a75ebb83250a71fd6aec0ad5924e1b6948f3d94d5fcf3fd1',
  'e64cdb489cd23484d61d86f1ede028b726c2a7f1db75a1edc135b939d1d478c2',
  '618114c9080f96d983fdb23f3b9573107a864e2e135b22fc41e7b7ae0045249c',
  'be7e819a0d8fd3cee2b105b010a63561c147650731252219f1b4f81e185990d4',
  'fa685c7300a907d4091cfdd4955185bdaca3d4718c27f6178bd0e2b566bde329',
  'b44f5faab877f1ba4c6674609a741fe18120d10d7dd481682c7c6f00b2b5752a',
  'd0bb409c6be4e774874517ad39b2f91429205f95f0ed1cd18148ab0f8e6a680d',
  '364679664c45583fad2ba17df7a657c13ee7388dc7cd0dc066637a641943a693',
  'e3978fb46c59ab83a11e5c36767ad81a7595b2a608bb3ef1aee164e86c24bddc',
  '76d30d8d0ec489ff5f1171ddadaaf6e776d042e56c4a715b479d4f7444705dd2',
  '3fa2d64a53983ff871afcb47aa204f7e937f7b84dd13067507c896e477949ce9',
  'ddaaf4e86037b301bfc6eeb25c7bd8684a03aee483549115498489464098e977',
  '6555ce1322e1d8bf8b1561b22fdbcfa260b9cec611d7913e7a0f5637000b53a6',
  'cb0f4f3c241fad6ebcb495c842d5aa2a54ca4dbbe5db263fc0f887e8eb69d6a3',
  '16ca607f8f761446283043c9a228782508038e9bb9e8d7fe8d9a16dec94929cb',
  '7f4bc705ebe7cffcf8092952d4d8aaad9cc8ebd1a712cd9f33648278f9ba5940',
  'a379f7c5c01207fe9d5a3d1e1985eedf4db40565dd8d455118040f82ea29c07b',
] as const;

describe('policy v0 decisions replay byte for byte', () => {
  const snapshots = fixtureSnapshots();

  it('the frozen hashes cover every move and the exploration branch', () => {
    expect(snapshots).toHaveLength(V0_DECISION_HASHES.length);
    expect(new Set(snapshots.map((s) => s.mode))).toEqual(new Set(['vertical', 'horizontal', 'variant', 'return']));
    expect(snapshots.some((s) => composeEncounter(s, COMPOSER_POLICY_V0).exploration.branch === 'explore')).toBe(true);
  });

  it.each(snapshots.map((snapshot, index) => [index, snapshot] as const))(
    'fixture %i composes to the stored v0 decision',
    (index, snapshot) => {
      const decision = composeEncounter(snapshot, COMPOSER_POLICY_V0);
      expect(decision.policyVersion).toBe('composer-policy.v0');
      expect(sha(decision)).toBe(V0_DECISION_HASHES[index]);
    },
  );

  it('replays under the policy the decision names, and not under another', () => {
    const [snapshot] = snapshots;
    const stored = composeEncounter(snapshot!, COMPOSER_POLICY_V0);
    expect(canonical(composeEncounter(stored.input, policyOf(stored.policyVersion)))).toBe(canonical(stored));
    expect(canonical(composeEncounter(stored.input, COMPOSER_POLICY_V1))).not.toBe(canonical(stored));
  });

  it('the setting names the policy: v0 by default and without one, v1 only when asked', () => {
    expect(composerPolicyFor('v0')).toBe(COMPOSER_POLICY_V0);
    expect(composerPolicyFor('v1')).toBe(COMPOSER_POLICY_V1);
    expect(composeEncounter(snapshots[0]!).policyVersion).toBe('composer-policy.v0');
    expect(composeEncounter(snapshots[0]!, composerPolicyFor('v1')).policyVersion).toBe('composer-policy.v1');
    expect(canonical(composeEncounter(snapshots[0]!))).toBe(
      canonical(composeEncounter(snapshots[0]!, COMPOSER_POLICY_V0)),
    );
  });

  it('a v0 decision carries no v1-only feature, so its record is unchanged', () => {
    for (const snapshot of snapshots)
      for (const evaluation of composeEncounter(snapshot, COMPOSER_POLICY_V0).evaluations)
        expect(Object.keys(evaluation.features)).not.toContain('recentTopic');
  });
});

describe('policy v1 is deterministic and bounded', () => {
  const snapshots = fixtureSnapshots();

  it('the same snapshot gives the same decision hash, and its label replays it', () => {
    for (const snapshot of snapshots) {
      const first = composeEncounter(snapshot, COMPOSER_POLICY_V1);
      expect(sha(composeEncounter(snapshot, COMPOSER_POLICY_V1))).toBe(sha(first));
      expect(canonical(composeEncounter(first.input, policyOf(first.policyVersion)))).toBe(canonical(first));
    }
  });

  it('every feature stays in [0, 1] and every offer is a candidate that was eligible', () => {
    for (const snapshot of snapshots) {
      const decision = composeEncounter(snapshot, COMPOSER_POLICY_V1);
      for (const evaluation of decision.evaluations)
        for (const value of Object.values(evaluation.features)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      for (const offer of decision.selection)
        expect(decision.evaluations.find((e) => e.assetId === offer.assetId)?.eligible).toBe(true);
    }
  });

  it('horizontal moves score as in v0: v1 changes only the vertical blend', () => {
    for (const snapshot of snapshots.filter((s) => s.mode === 'horizontal')) {
      const v0 = composeEncounter(snapshot, COMPOSER_POLICY_V0);
      const v1 = composeEncounter(snapshot, COMPOSER_POLICY_V1);
      expect(v1.evaluations.map((e) => e.score)).toEqual(v0.evaluations.map((e) => e.score));
      expect(v1.selection.map((s) => s.assetId)).toEqual(v0.selection.map((s) => s.assetId));
    }
  });
});

const neutral = {
  intent: 1,
  interest: 0.5,
  format: 0.5,
  novelty: 0.5,
  semanticFit: 0.5,
  continuity: 0.5,
  recentRepetition: 0,
};

describe('recent-topic repeat penalty', () => {
  const recent = (...topics: string[][]) => topics.map((topicIds) => ({ topicIds }));

  it('weighs the newest encounters most: 3, 2, 1 of 6', () => {
    expect(recentTopicRepeat(recent(['a'], ['b'], ['b']), ['a'], 3)).toBeCloseTo(3 / 6);
    expect(recentTopicRepeat(recent(['b'], ['a'], ['b']), ['a'], 3)).toBeCloseTo(2 / 6);
    expect(recentTopicRepeat(recent(['b'], ['b'], ['a']), ['a'], 3)).toBeCloseTo(1 / 6);
    expect(recentTopicRepeat(recent(['a'], ['a'], ['a']), ['a'], 3)).toBe(1);
  });

  it('is neutral without history or topics, and ignores encounters beyond the span', () => {
    expect(recentTopicRepeat([], ['a'], 3)).toBe(0);
    expect(recentTopicRepeat(recent(['a']), [], 3)).toBe(0);
    expect(recentTopicRepeat([{}], ['a'], 3)).toBe(0);
    expect(recentTopicRepeat(recent(['b'], ['b'], ['b'], ['a']), ['a'], 3)).toBe(0);
    expect(recentTopicRepeat(recent(['a']), ['a'], 0)).toBe(0);
  });

  test.prop([
    fc.array(fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }), { maxLength: 8 }),
    fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }),
    fc.integer({ min: 0, max: 5 }),
  ])('stays in [0, 1] for any history, candidate and span', (history, candidateTopics, span) => {
    const value = recentTopicRepeat(
      history.map((topicIds) => ({ topicIds })),
      candidateTopics,
      span,
    );
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('costs a vertical candidate its weight times the share, and a horizontal move or policy v0 nothing', () => {
    expect(score({ ...neutral, recentTopic: 0.5 }, false, COMPOSER_POLICY_V1)).toBeCloseTo(
      score({ ...neutral, recentTopic: 0 }, false, COMPOSER_POLICY_V1) - 0.5 * COMPOSER_POLICY_V1.vertical.recentTopic,
    );
    expect(score({ ...neutral, recentTopic: 1 }, true, COMPOSER_POLICY_V1)).toBe(
      score(neutral, true, COMPOSER_POLICY_V1),
    );
    expect(score({ ...neutral, recentTopic: 1 }, false, COMPOSER_POLICY_V0)).toBe(
      score(neutral, false, COMPOSER_POLICY_V0),
    );
  });

  it('leaves the topic: a new topic beats a same-topic candidate the person just read, under v1 and not v0', () => {
    const base = fixtureSnapshots()[0]!;
    const topicOf = (topicId: string, index: number) => ({
      admitted: true,
      accessible: true,
      renderable: true,
      encounter: {
        assetId: `asset-${String(index)}`,
        assetRevision: 1,
        kind: 'scroll' as const,
        explanationUnitId: `unit-${String(index)}`,
        metadata: { kind: 'scroll' as const, title: `Fixture ${String(index)}`, summary: '', language: 'en' },
        topics: [{ topicId, role: 'primary' as const, weight: 1 }],
        facets: [`facet-${String(index)}`],
        siblings: [],
        catalogWatermark: 'fixture-catalog',
        attributionVersion: 'fixture-taxonomy',
      },
    });
    const snapshot: ComposerSnapshot = {
      ...base,
      mode: 'vertical',
      seed: 'fixture-seed-no-explore-9',
      intent: { language: 'en', topicIds: ['earth.seasons'], text: '' },
      source: { assetId: 'source', assetRevision: 1 },
      candidates: [topicOf('earth.seasons', 1), topicOf('earth.tides', 2)],
      explorationPool: [],
      evidence: {
        universeId: base.universeId,
        privacyEpoch: base.privacyEpoch,
        evaluatedAt: base.evaluatedAt,
        watermark: base.watermarks.context,
        policyVersion: 'fixture-actual-activity',
        topics: [{ topicId: 'earth.seasons', activity: 2, formats: [] }],
        recent: [
          {
            exposureId: 'e1',
            activatedAt: '2026-10-30T11:50:00.000Z',
            explanationUnitId: 'unit-source',
            facets: [],
            topicIds: ['earth.seasons'],
          },
          {
            exposureId: 'e2',
            activatedAt: '2026-10-30T11:40:00.000Z',
            explanationUnitId: 'unit-prior',
            facets: [],
            topicIds: ['earth.seasons'],
          },
        ],
        hiddenAssetIds: [],
      },
    };
    const first = (policy: typeof COMPOSER_POLICY_V0) => composeEncounter(snapshot, policy).selection[0]?.assetId;
    expect(first(COMPOSER_POLICY_V0)).toBe('asset-1');
    expect(first(COMPOSER_POLICY_V1)).toBe('asset-2');
    const v1 = composeEncounter(snapshot, COMPOSER_POLICY_V1);
    expect(v1.evaluations.find((e) => e.assetId === 'asset-1')?.features.recentTopic).toBeCloseTo(5 / 6);
    expect(v1.evaluations.find((e) => e.assetId === 'asset-2')?.features.recentTopic).toBe(0);
  });
});

describe('play-level format cells shrink toward the rate of the person’s other levels', () => {
  const game = { kind: 'scroll' as const, traits: { playLevel: 'game' as const } };
  type Counts = { readonly measured: number; readonly qualified: number };
  /** Other levels of the topic at 4 of 8 (rate 1/2, shrunk to 5/10). */
  const rest: Counts = { measured: 8, qualified: 4 };
  const restFit = (1 + 4) / (2 + 8);
  /** A person with `rest` at other levels and `cell` at the game level. The parent counts every level, the cell included. */
  const person = (others: Counts, cell?: Counts) => ({
    topicId: 't',
    activity: 1,
    formats: [
      {
        kind: 'scroll' as const,
        measured: others.measured + (cell?.measured ?? 0),
        qualified: others.qualified + (cell?.qualified ?? 0),
      },
    ],
    ...(cell ? { cells: [{ kind: 'scroll' as const, level: 'game' as const, ...cell }] } : {}),
  });
  const fit = (others: Counts, cell: Counts, policy = COMPOSER_POLICY_V1) =>
    formatFitOf(person(others, cell), game, policy);

  it('a cell with no encounters equals its parent, and policy v0 never reads a cell', () => {
    expect(formatFitOf(person(rest), game, COMPOSER_POLICY_V1)).toBeCloseTo(restFit);
    expect(fit(rest, { measured: 0, qualified: 0 })).toBeCloseTo(restFit);
    const parent = (1 + 4 + 6) / (2 + 8 + 6);
    expect(fit(rest, { measured: 6, qualified: 6 }, COMPOSER_POLICY_V0)).toBeCloseTo(parent);
  });

  it('a cell with few encounters stays near the other levels and moves toward its own rate as they accumulate', () => {
    const at = (measured: number, qualified: number) => fit(rest, { measured, qualified });
    expect(at(1, 1)).toBeCloseTo((1 + 4 * restFit) / 5);
    expect(Math.abs(at(1, 1) - restFit)).toBeLessThan(0.15);
    expect(at(1, 1)).toBeLessThan(at(4, 4));
    expect(at(4, 4)).toBeLessThan(at(20, 20));
    expect(at(20, 20)).toBeGreaterThan(0.85);
    expect(at(20, 0)).toBeLessThan(0.15);
  });

  it('does not count the cell twice: history in one level only is shrunk toward even odds, not toward itself', () => {
    const onlyGame = { measured: 6, qualified: 6 };
    const none: Counts = { measured: 0, qualified: 0 };
    const parent = (1 + 6) / (2 + 6);
    // (6 + 4 * 1/2) / (6 + 4): less extreme than the parent, which already holds these six encounters once.
    expect(fit(none, onlyGame)).toBeCloseTo(0.8);
    expect(fit(none, onlyGame)).toBeLessThan(parent);
    // Another level of the same person has no history of its own, so it reads the parent as it is.
    const plain = { kind: 'scroll' as const, traits: { playLevel: 'plain' as const } };
    expect(formatFitOf(person(none, onlyGame), plain, COMPOSER_POLICY_V1)).toBeCloseTo(parent);
  });

  it('a candidate reads its own level: a plain Scroll is not moved by a game cell', () => {
    const plain = { kind: 'scroll' as const, traits: { playLevel: 'plain' as const } };
    const withGame = person(rest, { measured: 6, qualified: 6 });
    const parent = (1 + 10) / (2 + 14);
    expect(formatFitOf(withGame, plain, COMPOSER_POLICY_V1)).toBeCloseTo(parent);
    expect(formatFitOf(withGame, { kind: 'scroll' as const }, COMPOSER_POLICY_V1)).toBeCloseTo(parent);
    expect(formatFitOf(withGame, game, COMPOSER_POLICY_V1)).toBeGreaterThan(parent);
  });

  it('two people with the same other levels diverge on a game Scroll only after enough measured encounters', () => {
    const gap = (n: number) => fit(rest, { measured: n, qualified: n }) - fit(rest, { measured: n, qualified: 0 });
    expect(gap(0)).toBeCloseTo(0);
    // n / (n + 4): a single encounter each moves them 0.2 apart, eight move them two thirds.
    expect(gap(1)).toBeCloseTo(1 / 5);
    expect(gap(3)).toBeCloseTo(3 / 7);
    expect(gap(8)).toBeCloseTo(8 / 12);
    expect(gap(1)).toBeLessThan(gap(3));
    expect(gap(3)).toBeLessThan(gap(8));
  });

  const counts = fc
    .tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 200 }))
    .map(([measured, spare]) => ({ measured, qualified: Math.min(measured, spare) }));

  test.prop([counts, counts, fc.constantFrom('plain' as const, 'stage' as const, 'game' as const)])(
    'is always in [0, 1], and between the rate of the other levels and the cell’s own rate',
    (others, cell, level) => {
      const topic = {
        topicId: 't',
        activity: 0,
        formats: [
          {
            kind: 'scroll' as const,
            measured: others.measured + cell.measured,
            qualified: others.qualified + cell.qualified,
          },
        ],
        cells: [{ kind: 'scroll' as const, level, ...cell }],
      };
      const value = formatFitOf(topic, { kind: 'scroll', traits: { playLevel: level } }, COMPOSER_POLICY_V1);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      if (cell.measured > 0) {
        const prior = (1 + others.qualified) / (2 + others.measured);
        const own = cell.qualified / cell.measured;
        expect(value).toBeGreaterThanOrEqual(Math.min(prior, own) - 1e-9);
        expect(value).toBeLessThanOrEqual(Math.max(prior, own) + 1e-9);
      }
    },
  );

  it('survives a parent that lacks the cell’s counts (a process from before migration 0082)', () => {
    const behind = {
      topicId: 't',
      activity: 0,
      formats: [{ kind: 'scroll' as const, measured: 2, qualified: 1 }],
      cells: [{ kind: 'scroll' as const, level: 'game' as const, measured: 5, qualified: 5 }],
    };
    const value = formatFitOf(behind, game, COMPOSER_POLICY_V1);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('the Format feature of a candidate reads the cell through the whole feature step', () => {
    const base = fixtureSnapshots()[0]!;
    const gameCandidate = {
      ...base.candidates[0]!,
      encounter: { ...base.candidates[0]!.encounter, kind: 'scroll' as const, traits: { playLevel: 'game' as const } },
    };
    const topicId = gameCandidate.encounter.topics[0]!.topicId;
    const formatFor = (qualified: number) => {
      const snapshot: ComposerSnapshot = {
        ...base,
        candidates: [gameCandidate],
        evidence: {
          ...base.evidence!,
          recent: [],
          topics: [{ ...person(rest, { measured: 8, qualified }), topicId }],
        },
      };
      return features(snapshot, gameCandidate, COMPOSER_POLICY_V1).format;
    };
    expect(formatFor(8)).toBeGreaterThan(formatFor(0));
  });
});

describe('exploration covers each play level, and keeps the share of Reels', () => {
  type Member = 'reel' | 'plain' | 'stage' | 'game';
  const catalogue = (members: readonly Member[], seed: string): ComposerSnapshot => ({
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt: '2026-10-30T12:00:00.000Z',
    watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
    mode: 'vertical',
    seed,
    intent: { language: 'en', topicIds: [], text: '' },
    candidates: members.map((member, index) => {
      const kind = member === 'reel' ? ('reel' as const) : ('scroll' as const);
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
          topics: [{ topicId: 'fixture.topic', role: 'primary' as const, weight: 1 }],
          facets: [],
          siblings: [],
          ...(member === 'reel' ? {} : { traits: { playLevel: member } }),
          catalogWatermark: 'fixture-catalog',
          attributionVersion: 'fixture-taxonomy',
        },
      };
    }),
    explorationPool: members.map((_, index) => ({ assetId: `asset-${String(index)}`, assetRevision: 1 })),
  });
  /** How often the first offer of an exploration is each member, over 4000 seeds of one validated snapshot. */
  const shares = (members: readonly Member[], policy: typeof COMPOSER_POLICY_V0) => {
    const snapshot = catalogue(members, 'seed');
    validateSnapshot(snapshot);
    const counts = new Map<Member, number>();
    let explored = 0;
    for (let n = 0; n < 4000; n += 1) {
      const decision = decideValidated({ ...snapshot, seed: `seed-${String(n)}` }, policy);
      if (decision.exploration.branch !== 'explore') continue;
      explored += 1;
      const first = Number(decision.selection[0]!.assetId.split('-')[1]);
      counts.set(members[first]!, (counts.get(members[first]!) ?? 0) + 1);
    }
    const share = (member: Member) => (counts.get(member) ?? 0) / explored;
    return { explored, share };
  };
  const scrolls = [...Array.from({ length: 20 }, () => 'plain' as const), 'game' as const];

  it('draws a level first: a lone game Scroll in a plain catalogue is explored about half the time, not 1 in 21', () => {
    const { explored, share } = shares(scrolls, COMPOSER_POLICY_V1);
    expect(explored).toBeGreaterThan(300);
    expect(share('game')).toBeGreaterThan(0.4);
    expect(share('game')).toBeLessThan(0.6);
  }, 30_000);

  it('under v0 the same pool is drawn uniformly, so the game Scroll is explored about 1 in 21', () => {
    expect(shares(scrolls, COMPOSER_POLICY_V0).share('game')).toBeLessThan(0.15);
  }, 30_000);

  it('keeps Reel and Scroll equal: the Reels of the pool are explored as often as under v0, not squeezed by the levels', () => {
    const mixed: Member[] = [
      ...Array.from({ length: 10 }, () => 'reel' as const),
      ...Array.from({ length: 10 }, () => 'plain' as const),
      'stage',
      'game',
    ];
    const v0 = shares(mixed, COMPOSER_POLICY_V0);
    const v1 = shares(mixed, COMPOSER_POLICY_V1);
    const reels = (shares_: typeof v0) => shares_.share('reel');
    // 10 of 22 members are Reels, whichever policy draws.
    expect(reels(v0)).toBeGreaterThan(0.37);
    expect(reels(v0)).toBeLessThan(0.54);
    expect(reels(v1)).toBeGreaterThan(0.37);
    expect(reels(v1)).toBeLessThan(0.54);
    // The Scrolls' share is spread over their levels: stage and game are explored far more than 1 in 22.
    expect(v1.share('game')).toBeGreaterThan(0.1);
    expect(v0.share('game')).toBeLessThan(0.1);
  }, 30_000);

  /**
   * What 4000 seeds of one validated snapshot did: how often each member was the first offer, and every probability the
   * decisions recorded for it. The seed changes the exploration draw only, so the ranked winner is the same throughout.
   */
  const firstOffers = (poolMembers: readonly Member[], policy: typeof COMPOSER_POLICY_V0) => {
    const snapshot = catalogue(poolMembers, 'seed');
    validateSnapshot(snapshot);
    const seeds = 4000;
    const counts = new Map<string, number>();
    const recorded = new Map<string, Set<number>>();
    let winner = '';
    let fraction = 0;
    for (let n = 0; n < seeds; n += 1) {
      const decision = decideValidated({ ...snapshot, seed: `seed-${String(n)}` }, policy);
      const first = decision.selection[0]!.assetId;
      counts.set(first, (counts.get(first) ?? 0) + 1);
      recorded.set(first, (recorded.get(first) ?? new Set<number>()).add(decision.exploration.selectedProbability));
      winner = decision.exploration.rankedWinner!.assetId;
      fraction = decision.exploration.fraction;
    }
    return { seeds, counts, recorded, winner, fraction };
  };

  /** Upper 0.1% point of the chi-square distribution (Wilson-Hilferty), for `df` degrees of freedom. */
  const chiSquareLimit = (df: number) => df * (1 - 2 / (9 * df) + 3.0902 * Math.sqrt(2 / (9 * df))) ** 3;

  const shapes: readonly (readonly [string, readonly Member[]])[] = [
    ['Reels only', Array.from({ length: 8 }, () => 'reel' as const)],
    ['one level', Array.from({ length: 12 }, () => 'plain' as const)],
    [
      'Scrolls of mixed levels',
      [...Array.from({ length: 8 }, () => 'plain' as const), 'stage', 'stage', 'stage', 'game'],
    ],
    [
      'Reels and Scrolls of mixed levels',
      [
        ...Array.from({ length: 10 }, () => 'reel' as const),
        ...Array.from({ length: 10 }, () => 'plain' as const),
        'stage',
        'game',
      ],
    ],
  ];
  const policies = [
    ['v0', COMPOSER_POLICY_V0],
    ['v1', COMPOSER_POLICY_V1],
  ] as const;

  it.each(shapes.flatMap(([shape, pool]) => policies.map(([name, policy]) => [shape, name, pool, policy] as const)))(
    'the probability of the first offer is its observed frequency: %s, policy %s',
    (_shape, _name, poolMembers, policy) => {
      const pool = poolMembers.map((member, index) => ({
        id: `asset-${String(index)}`,
        kind: member === 'reel' ? ('reel' as const) : ('scroll' as const),
        level: member === 'reel' ? ('plain' as const) : member,
      }));
      const observed = firstOffers(poolMembers, policy);
      let chiSquare = 0;
      for (const member of pool) {
        // epsilon times the member's share of the exploration, plus the ranked winner's 1 - epsilon.
        const expected =
          (member.id === observed.winner ? 1 - observed.fraction : 0) +
          observed.fraction * explorationShare(pool, member, policy.explorationByPlayLevel);
        // What the decisions recorded for it is exactly that ...
        for (const probability of observed.recorded.get(member.id) ?? []) expect(probability).toBeCloseTo(expected, 12);
        // ... and the draw really gives it that often (a goodness of fit over every member at once).
        const count = observed.counts.get(member.id) ?? 0;
        chiSquare += (count - observed.seeds * expected) ** 2 / (observed.seeds * expected);
      }
      expect(observed.recorded.size).toBeGreaterThan(1);
      expect(chiSquare).toBeLessThan(chiSquareLimit(pool.length - 1));
    },
    120_000,
  );

  it('gives each member of a small pool its exact share of the exploration', () => {
    // 2 Reels, 3 plain Scrolls and 1 game Scroll: a member is drawn from 6, and a Scroll (4 of 6) is then redrawn by level.
    const pool = [
      { kind: 'reel' as const, level: 'plain' as const },
      { kind: 'reel' as const, level: 'plain' as const },
      { kind: 'scroll' as const, level: 'plain' as const },
      { kind: 'scroll' as const, level: 'plain' as const },
      { kind: 'scroll' as const, level: 'plain' as const },
      { kind: 'scroll' as const, level: 'game' as const },
    ];
    const reel = pool[0]!;
    const plain = pool[2]!;
    const game = pool[5]!;
    expect(explorationShare(pool, reel, true)).toBeCloseTo(1 / 6, 12);
    expect(explorationShare(pool, plain, true)).toBeCloseTo(4 / 6 / 2 / 3, 12);
    expect(explorationShare(pool, game, true)).toBeCloseTo(4 / 6 / 2 / 1, 12);
    for (const member of pool) expect(explorationShare(pool, member, false)).toBeCloseTo(1 / 6, 12);
  });

  const members = fc.array(
    fc.record({
      kind: fc.constantFrom('reel' as const, 'scroll' as const),
      level: fc.constantFrom('plain' as const, 'stage' as const, 'game' as const),
    }),
    { minLength: 1, maxLength: 30 },
  );

  test.prop([members])(
    'the exploration probabilities of a pool sum to 1, so the recorded probability is a distribution',
    (pool) => {
      for (const byPlayLevel of [false, true]) {
        const total = pool.reduce((sum, item) => sum + explorationShare(pool, item, byPlayLevel), 0);
        expect(total).toBeCloseTo(1);
      }
    },
  );

  test.prop([members])('the Reels of a pool hold exactly their share of it, whatever the play levels', (pool) => {
    const reels = pool.filter((item) => item.kind === 'reel');
    const total = reels.reduce((sum, item) => sum + explorationShare(pool, item, true), 0);
    expect(total).toBeCloseTo(reels.length / pool.length);
  });
});

describe('the inputs carry no play data (D-063)', () => {
  const base = fixtureSnapshots().find((s) => s.evidence !== undefined && s.mode === 'vertical')!;
  const withCell = (cell: object): ComposerSnapshot =>
    ({
      ...base,
      evidence: {
        ...base.evidence!,
        topics: [{ topicId: 't', activity: 1, formats: [], cells: [cell] }],
      },
    }) as ComposerSnapshot;
  const cell = { kind: 'scroll', level: 'game', measured: 2, qualified: 1 };

  it('accepts a cell of counts of reading', () => {
    expect(() => composeEncounter(withCell(cell))).not.toThrow();
  });

  it.each(['correct', 'right', 'pick', 'option', 'sparks', 'combo', 'tier', 'landmark', 'called'])(
    'refuses a cell that carries `%s`',
    (field) => {
      expect(() => composeEncounter(withCell({ ...cell, [field]: 1 }))).toThrow('COMPOSER_SNAPSHOT_INVALID');
    },
  );

  it.each(['correct', 'sparks', 'tier'])('refuses a candidate whose traits carry `%s`', (field) => {
    const candidate = base.candidates[0]!;
    const snapshot = {
      ...base,
      candidates: [
        { ...candidate, encounter: { ...candidate.encounter, traits: { playLevel: 'game', [field]: 1 } } },
        ...base.candidates.slice(1),
      ],
    } as ComposerSnapshot;
    expect(() => composeEncounter(snapshot)).toThrow('COMPOSER_SNAPSHOT_INVALID');
  });
});
