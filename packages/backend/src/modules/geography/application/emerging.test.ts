import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { EMERGING_LIMITS } from '@knowscroll/contracts';
import { fixtureSnapshot, staticCatalogue } from '../../content/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import { makeReadOwnEmerging } from './emerging.js';
import type { EmergingPorts } from './ports.js';

const universeId = '0199f0a0-0000-7000-8000-000000000001';
const authority = { universeId, privacyEpoch: 1 } as unknown as PersonalAuthority;

/** Twenty systems, each with a topic, more than the contract holds. Authored; not the product catalogue. */
const systems = Array.from({ length: 20 }, (_, n) => ({
  id: `system-${String(n).padStart(2, '0')}`,
  parent: null,
  facets: [],
}));
const catalogue = staticCatalogue(
  fixtureSnapshot(
    systems.flatMap((system) => [
      system,
      { id: `${system.id}.topic`, parent: system.id, facets: [`${system.id}.topic.angle`] },
    ]),
  ),
);

function readOwn(established: readonly string[] = []) {
  const ports = {
    catalogue,
    withScope: async (_authority: unknown, work: (scope: unknown) => Promise<unknown>) => ({
      kind: 'entered',
      value: await work({ authority, revisionAtEntry: 4 }),
    }),
    ownerActive: () => Promise.resolve(true),
    store: {
      view: () =>
        Promise.resolve({
          state: { revision: 3, structureRevision: 3, activityRevision: 3 },
          objects: established.map((id) => ({ kind: 'system', conceptId: id })),
        }),
    },
    readSnapshot: (_scope: unknown, query: { topicIds: readonly string[] }) =>
      Promise.resolve({ topics: query.topicIds.map((topicId) => ({ topicId, qualifiedExplanationUnits: 1 })) }),
    hash: canonicalSha256,
    now: () => new Date('2026-11-11T00:00:00.000Z'),
  } as unknown as EmergingPorts;
  return makeReadOwnEmerging(ports)(authority, {});
}

describe('dust for a reader who is gathering toward many systems (#674)', () => {
  it('stays within the contract cap instead of failing the read', async () => {
    const result = await readOwn();
    if (result.kind !== 'read') throw new Error('expected a read');
    expect(result.emerging.dust).toHaveLength(EMERGING_LIMITS.dust);
  });

  it('shows the same cues on every read, and lets the next system in once one is established', async () => {
    const first = await readOwn();
    const again = await readOwn();
    const afterOne = await readOwn([systems[0]!.id]);
    if (first.kind !== 'read' || again.kind !== 'read' || afterOne.kind !== 'read') throw new Error('expected reads');
    expect(again.emerging.dust).toEqual(first.emerging.dust);
    expect(afterOne.emerging.dust).toHaveLength(EMERGING_LIMITS.dust);
    expect(afterOne.emerging.dust).not.toEqual(first.emerging.dust);
  });
});
