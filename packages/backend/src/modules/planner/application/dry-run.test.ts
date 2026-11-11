import { describe, expect, it } from 'vitest';
import { DISCOVERY_MAX_TOPICS } from '../../content/public.js';
import type { PersonalScopeTx, ScopeOutcome } from '../../identity/public.js';
import { makePlannerDryRun, type PlannerDryRunPorts } from './dry-run.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const UNIVERSE = '11111111-1111-4111-8111-111111111111';

/** Only what the dry run reads. Titles, summaries, topics and units are private words a leak would show. */
function ports(
  over: {
    readonly recording?: 'recording' | 'paused' | 'unavailable';
    readonly proof?: 'available' | 'unavailable';
    readonly evidence?: number;
    readonly enabled?: boolean;
    readonly refuse?: 'universe_suspended';
    readonly epochs?: number[];
  } = {},
): PlannerDryRunPorts {
  const evidence = Array.from({ length: over.evidence ?? 2 }, (_, i) => ({
    qualified: true,
    exposureId: `exposure-${i}`,
    explanationUnitId: `CI-PRIVATE-UNIT-${i}`,
    topics: [{ topicId: 'CI-PRIVATE-TOPIC', role: 'primary' }],
  }));
  return {
    now: () => NOW,
    capabilities: {},
    hash: () => 'h',
    enabled: () => over.enabled ?? true,
    withPersonalScope: <T>(authority: { privacyEpoch: number }, work: (scope: PersonalScopeTx) => Promise<T>) => {
      over.epochs?.push(authority.privacyEpoch);
      if (over.refuse) return Promise.resolve({ kind: 'refused', refusal: { kind: over.refuse } } as ScopeOutcome<T>);
      if (authority.privacyEpoch === 1 && over.epochs)
        return Promise.resolve({
          kind: 'refused',
          refusal: { kind: 'epoch_changed', currentEpoch: 5 },
        } as ScopeOutcome<T>);
      return work({ revisionAtEntry: 1, authority } as unknown as PersonalScopeTx).then((value): ScopeOutcome<T> => ({
        kind: 'entered',
        value,
      }));
    },
    readRecordingNow: () =>
      Promise.resolve(
        over.recording === 'paused' || over.recording === 'unavailable'
          ? { kind: over.recording }
          : { kind: 'recording', generation: 1 },
      ),
    fenceRecording: () => Promise.resolve({ kind: 'recording', scope: {} } as never),
    store: {
      state: () => Promise.resolve({ desiredRevision: 1, materialRevision: 1, acceptedRevision: 0 }),
      revisions: () => Promise.resolve([]),
    },
    readRecentTopics: () => Promise.resolve({ topicIds: ['CI-PRIVATE-TOPIC'], hasMore: false }),
    readInventory: () =>
      Promise.resolve([
        {
          assetId: 'asset-1',
          assetRevision: 1,
          catalogWatermark: 'w',
          explanationUnitId: 'CI-PRIVATE-UNIT-INVENTORY',
          kind: 'scroll',
          metadata: { title: 'CI-PRIVATE-TITLE', summary: 'CI-PRIVATE-SUMMARY' },
          topics: [{ topicId: 'CI-PRIVATE-TOPIC', role: 'primary' }],
        },
      ]),
    readSnapshot: () =>
      Promise.resolve({
        revision: 1,
        proofAvailability: over.proof ?? 'available',
        supportingEvidence: evidence,
        routing: { recent: [], established: [], hiddenAssetIds: [] },
        topics: [],
      }),
  } as unknown as PlannerDryRunPorts;
}

const report = async (over: Parameters<typeof ports>[0] = {}) => {
  const result = await makePlannerDryRun(ports(over))(UNIVERSE);
  if (result.kind !== 'read') throw new Error(`CI expected a read, got ${result.refusal}`);
  return result.report;
};

describe('the Planner dry run (D-411)', () => {
  it('says the run calls the model for a reader with evidence, with the counts it would freeze', async () => {
    expect(await report()).toMatchObject({
      outcome: 'calls_model',
      wouldCallModel: true,
      wouldRecord: null,
      roleEnabled: true,
      topics: 1,
      inventoryTopicBound: DISCOVERY_MAX_TOPICS,
      inventoryItems: 1,
      evidence: 2,
      intentTopics: 0,
      planOpportunities: 0,
      recentHasMore: false,
      topicsTruncated: false,
    });
    const frozen = await report();
    expect(frozen.contextBytes).toBeGreaterThan(100);
    expect(frozen.modelItems).toBeGreaterThan(0);
  });

  it('says a reader with no qualified evidence is insufficient and no model is called', async () => {
    expect(await report({ evidence: 0 })).toMatchObject({
      outcome: 'insufficient_evidence',
      wouldCallModel: false,
      wouldRecord: { status: 'insufficient', outcome: 'insufficient_evidence' },
      evidence: 0,
    });
  });

  it('says what a missing proof, a switched-off role and a paused or unusable recording come to', async () => {
    expect(await report({ proof: 'unavailable' })).toMatchObject({
      outcome: 'proof_unavailable',
      wouldRecord: { status: 'blocked', outcome: 'proof_unavailable' },
      topics: null,
      evidence: null,
    });
    expect(await report({ enabled: false })).toMatchObject({
      outcome: 'disabled',
      roleEnabled: false,
      wouldRecord: { status: 'blocked', outcome: 'blocked_disabled' },
    });
    expect(await report({ recording: 'paused' })).toMatchObject({
      outcome: 'recording_paused',
      wouldRecord: null,
      topics: null,
    });
    expect(await report({ recording: 'unavailable' })).toMatchObject({ outcome: 'not_runnable', wouldRecord: null });
  });

  it('claims epoch 1, then the epoch it is told is current, and refuses what the scope refuses', async () => {
    const epochs: number[] = [];
    expect(await report({ epochs })).toMatchObject({ outcome: 'calls_model' });
    expect(epochs).toEqual([1, 5]);
    expect(await makePlannerDryRun(ports({ refuse: 'universe_suspended' }))(UNIVERSE)).toEqual({
      kind: 'refused',
      refusal: 'universe_suspended',
    });
  });

  it('prints counts and codes only: no topic, title, summary, unit or id', async () => {
    const text = JSON.stringify(await report());
    for (const word of ['CI-PRIVATE', 'asset-1', 'exposure-', UNIVERSE]) expect(text).not.toContain(word);
    const leaves = (value: unknown): unknown[] =>
      value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value];
    for (const leaf of leaves(JSON.parse(text))) {
      if (typeof leaf === 'string') expect(leaf).toMatch(/^[a-z_]+$/);
      else expect(['number', 'boolean'].includes(typeof leaf) || leaf === null).toBe(true);
    }
  });
});
