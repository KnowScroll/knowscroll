import { describe, expect, it } from 'vitest';
import { COMPOSER_POLICY_V1, COMPOSER_POLICY_V2, composeEncounter, type ComposerSnapshot } from '../public.js';
import { LOW_HEADROOM_UNITS, gapSignalsOf } from './gap-signals.js';
import { withGapSignals } from '../adapters/gap-signal-persist.js';
import type { PersonalScopeTx } from '../../identity/public.js';

/**
 * Where a decision shows content running out (#674, D-414): labelled CI fixtures, never product data. Every decision is made by the
 * real policy over a small snapshot; the signal is read from the decision alone.
 */
type Candidate = ComposerSnapshot['candidates'][number];
const TOPIC = 'fixture.tides';
const OTHER = 'fixture.stars';

const candidate = (
  name: string,
  topic = TOPIC,
  role: 'primary' | 'supporting' | 'incidental' = 'primary',
  kind: 'reel' | 'scroll' = 'scroll',
): Candidate => ({
  admitted: true,
  accessible: true,
  renderable: true,
  encounter: {
    assetId: name,
    assetRevision: 1,
    kind,
    explanationUnitId: `unit-${name}`,
    metadata: { kind, title: `Fixture ${name}`, summary: '', language: 'en' },
    topics: [{ topicId: topic, role, weight: 1 }],
    facets: [],
    siblings: [],
    catalogWatermark: 'fixture-catalog',
    attributionVersion: 'fixture-taxonomy',
  },
});

/** A vertical move; `met` names the explanation units the person has already met. */
function vertical(
  candidates: readonly Candidate[],
  met: readonly string[] = [],
  mode: ComposerSnapshot['mode'] = 'vertical',
): ComposerSnapshot {
  const evaluatedAt = '2026-11-11T12:00:00.000Z';
  return {
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt,
    seed: 'fixture-seed',
    mode,
    intent: { language: 'en', topicIds: [TOPIC], text: '', explanationUnitId: 'unit-source' },
    source: { assetId: 'source', assetRevision: 1 },
    candidates,
    explorationPool: [],
    evidence: {
      universeId: 'fixture-universe',
      privacyEpoch: 1,
      evaluatedAt,
      watermark: 'x',
      policyVersion: 'fixture-actual-activity',
      topics: [],
      recent: [],
      established: {
        policyVersion: 'retained-activated-history.v0',
        watermark: 'x',
        units: [...new Set(candidates.map((c) => c.encounter.explanationUnitId))].map((explanationUnitId) => ({
          explanationUnitId,
          encountered: met.includes(explanationUnitId),
          facets: [],
        })),
      },
      hiddenAssetIds: [],
    },
    watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
  };
}

const decide = (snapshot: ComposerSnapshot) =>
  composeEncounter(snapshot, { ...COMPOSER_POLICY_V2, explorationFraction: 0 });
const signals = (snapshot: ComposerSnapshot) => gapSignalsOf(decide(snapshot), COMPOSER_POLICY_V2.maxCandidates);

describe('the last resort is a signal for the planet the reader was given a repeat from', () => {
  it('names the primary topic of the first offer when nothing unseen was eligible in either format', () => {
    const snapshot = vertical([candidate('a'), candidate('b', OTHER)], ['unit-a', 'unit-b']);
    expect(decide(snapshot).unseenLadder?.outcome).toBe('fell_back');
    expect(signals(snapshot)).toHaveLength(1);
    expect(signals(snapshot)[0]).toMatchObject({ source: 'last_resort' });
  });

  it('is no signal when something unseen was offered with room to spare', () => {
    const snapshot = vertical([candidate('a'), candidate('b'), candidate('c')], []);
    expect(signals(snapshot)).toEqual([]);
  });
});

describe('low headroom is a signal for a topic with at most one unseen explanation left', () => {
  it('fires when the unseen explanation offered is the last one about its topic', () => {
    // The topic's other explanations were met; one unseen is left, and it is what is offered.
    const snapshot = vertical([candidate('a'), candidate('b'), candidate('c')], ['unit-a', 'unit-b']);
    const decision = decide(snapshot);
    expect(decision.unseenLadder?.outcome).toBe('unseen');
    expect(gapSignalsOf(decision, 100)).toEqual([{ source: 'low_headroom', planet: TOPIC }]);
    expect(LOW_HEADROOM_UNITS).toBe(1);
  });

  it('counts each explanation once whatever its formats: a Reel and its Scroll twin are one unseen explanation', () => {
    const twin: Candidate = candidate('a-reel', TOPIC, 'primary', 'reel');
    const sameUnit: Candidate = { ...twin, encounter: { ...twin.encounter, explanationUnitId: 'unit-a' } };
    const one = vertical([candidate('a'), sameUnit], []);
    expect(signals(one)).toEqual([{ source: 'low_headroom', planet: TOPIC }]);
    const two = vertical([candidate('a'), candidate('b')], []);
    expect(signals(two)).toEqual([]);
  });

  it('speaks only for the topic the first offer is about, never for another topic of the snapshot', () => {
    const snapshot = vertical([candidate('a'), candidate('b'), candidate('x', OTHER)], []);
    const decision = decide(snapshot);
    const first = decision.selection[0]!.assetId;
    const aboutFirst = snapshot.candidates.find((c) => c.encounter.assetId === first)!.encounter.topics[0]!.topicId;
    expect(gapSignalsOf(decision, 100).every((signal) => signal.planet === aboutFirst)).toBe(true);
  });

  it('does not speak for a topic an offer only mentions in passing', () => {
    const snapshot = vertical([candidate('b', TOPIC, 'incidental')], []);
    const decision = decide(snapshot);
    expect(decision.selection.map((offer) => offer.assetId)).toEqual(['b']);
    expect(gapSignalsOf(decision, 100)).toEqual([]);
  });

  it('is no signal from a full snapshot, which is only a sample of the library', () => {
    const many = Array.from({ length: 100 }, (_, n) => candidate(`m${String(n)}`, OTHER));
    const snapshot = vertical([candidate('a'), ...many.slice(0, 99)], []);
    expect(snapshot.candidates).toHaveLength(100);
    expect(signals(snapshot)).toEqual([]);
  });
});

describe('only a system-chosen move under policy v2 has a ladder, and nothing about the decision changes', () => {
  it('is no signal under v1, for a series or related move, or when nothing was offered', () => {
    const snapshot = vertical([candidate('a')], ['unit-a']);
    expect(gapSignalsOf(composeEncounter(snapshot, COMPOSER_POLICY_V1), 100)).toEqual([]);
    expect(signals(vertical([candidate('a')], ['unit-a'], 'horizontal'))).toEqual([]);
    expect(signals(vertical([], []))).toEqual([]);
  });

  it('reads the decision and changes nothing in it: the same inputs give the same decision with or without the reading', () => {
    const snapshot = vertical([candidate('a'), candidate('b')], ['unit-a']);
    const before = JSON.stringify(decide(snapshot));
    gapSignalsOf(decide(snapshot), 100);
    expect(JSON.stringify(decide(snapshot))).toBe(before);
  });
});

describe('the decision is stored as before, and its signals are recorded only for a decision newly stored', () => {
  const scope = {} as PersonalScopeTx;
  const decision = decide(vertical([candidate('a')], ['unit-a']));

  it('records after a stored decision and not after a replay of one already stored', async () => {
    const recorded: unknown[] = [];
    const stored = withGapSignals(
      () => Promise.resolve('stored'),
      (_scope, found) => {
        recorded.push(found);
        return Promise.resolve();
      },
    );
    const replayed = withGapSignals(
      () => Promise.resolve('replayed'),
      (_scope, found) => {
        recorded.push(found);
        return Promise.resolve();
      },
    );
    expect(await stored(scope, { decisionId: 'd', commandId: 'c' }, decision)).toBe('stored');
    expect(recorded).toHaveLength(1);
    expect(await replayed(scope, { decisionId: 'd', commandId: 'c' }, decision)).toBe('replayed');
    expect(recorded).toHaveLength(1);
  });

  it('records nothing for a decision that carries no signal, and a refusing store records nothing at all', async () => {
    let calls = 0;
    const record = () => {
      calls += 1;
      return Promise.resolve();
    };
    const quiet = decide(vertical([candidate('a'), candidate('b'), candidate('c')], []));
    await withGapSignals(() => Promise.resolve('stored'), record)(scope, { decisionId: 'd', commandId: 'c' }, quiet);
    expect(calls).toBe(0);
    await expect(
      withGapSignals(() => Promise.reject(new Error('COMPOSER_REPLAY_INVALID')), record)(
        scope,
        { decisionId: 'd', commandId: 'c' },
        decision,
      ),
    ).rejects.toThrow('COMPOSER_REPLAY_INVALID');
    expect(calls).toBe(0);
  });
});
