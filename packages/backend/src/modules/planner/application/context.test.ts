import { describe, expect, it } from 'vitest';
import { DISCOVERY_MAX_TOPICS } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { prepareContext } from './context.js';
import type { PlannerPorts, PlannerState } from './ports.js';

const topics = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/** Only what `prepareContext` reads. The inventory port refuses an over-long topic list as Content does. */
function harness(input: { plan: readonly string[]; recent: readonly string[] }) {
  const inventoryReads: { topicIds?: readonly string[]; limit?: number }[] = [];
  const snapshotReads: { topicIds: readonly string[] }[] = [];
  const ports = {
    now: () => new Date('2026-11-11T12:00:00Z'),
    capabilities: {},
    readRecentTopics: () => Promise.resolve({ topicIds: input.recent, hasMore: false }),
    store: {
      revisions: () =>
        Promise.resolve(
          input.plan.length
            ? [
                {
                  opportunities: [
                    {
                      topicIds: input.plan,
                      explanationUnitId: 'unit-plan',
                      evidenceRefs: [],
                      eligibility: [],
                      formats: [],
                    },
                  ],
                },
              ]
            : [],
        ),
    },
    readInventory: (_scope: unknown, query: { topicIds?: readonly string[]; limit?: number }) => {
      inventoryReads.push(query);
      if ((query.topicIds?.length ?? 0) > DISCOVERY_MAX_TOPICS) throw new Error('DISCOVERY_QUERY_INVALID');
      return Promise.resolve([]);
    },
    readSnapshot: (_scope: unknown, query: { topicIds: readonly string[] }) => {
      snapshotReads.push(query);
      return Promise.resolve({
        revision: 1,
        proofAvailability: 'available',
        supportingEvidence: [],
        routing: { recent: [], established: [], hiddenAssetIds: [] },
      });
    },
    hash: () => 'h',
  } as unknown as PlannerPorts;
  return { ports, inventoryReads, snapshotReads };
}
const scope = { revisionAtEntry: 1 } as unknown as PersonalScopeTx;
const state = (intentTopics: readonly string[]): PlannerState => ({
  desiredRevision: 1,
  materialRevision: 1,
  acceptedRevision: 0,
  intent: { language: 'en', topicIds: [...intentTopics] },
});

describe('Planner context inventory read', () => {
  it('bounds the inventory topics to the discovery limit, keeping intent, then plan, then recent', async () => {
    const intent = topics('intent', 3),
      plan = topics('plan', 10),
      recent = topics('recent', 40);
    const { ports, inventoryReads, snapshotReads } = harness({ plan, recent });
    const context = await prepareContext(ports, scope, state(intent));
    expect(inventoryReads).toHaveLength(1);
    expect(inventoryReads[0]!.topicIds).toEqual([...intent, ...plan, ...recent].slice(0, DISCOVERY_MAX_TOPICS));
    expect(inventoryReads[0]!.topicIds).toHaveLength(DISCOVERY_MAX_TOPICS);
    expect(inventoryReads[0]!.limit).toBe(100);
    // The frozen topics and the snapshot read keep their own, wider bound.
    expect(context.facts.topics).toEqual([...intent, ...plan, ...recent]);
    expect(snapshotReads.at(-1)!.topicIds).toEqual([...intent, ...plan, ...recent]);
  });
  it('keeps every explicit intent topic when recent history alone would exceed the limit', async () => {
    const intent = topics('intent', DISCOVERY_MAX_TOPICS);
    const { ports, inventoryReads } = harness({ plan: [], recent: topics('recent', 30) });
    await prepareContext(ports, scope, state(intent));
    expect(inventoryReads[0]!.topicIds).toEqual(intent);
  });
  it('passes everything through when the topics already fit', async () => {
    const { ports, inventoryReads } = harness({ plan: topics('plan', 2), recent: topics('recent', 3) });
    await prepareContext(ports, scope, state(topics('intent', 1)));
    expect(inventoryReads[0]!.topicIds).toHaveLength(6);
  });
});
