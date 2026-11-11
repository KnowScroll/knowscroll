import { describe, expect, it } from 'vitest';
import type { PersonalAuthority, PersonalScopeTx, ScopeOutcome } from '../../identity/public.js';
import {
  PRUNE_DECISIONS,
  makeBackfillPruneDecisions,
  makePruneDecisions,
  type DecisionScanKey,
  type ExpiredDecisionsOwner,
} from './prune-decisions.js';

const owner = (n: number): ExpiredDecisionsOwner => ({ universeId: `universe-${String(n)}`, privacyEpoch: 1 });

/** Fake ports: records who was pruned and with what bound, and lets a test refuse or break a universe. */
function ports(
  owners: readonly ExpiredDecisionsOwner[],
  behaviour: {
    readonly refuse?: ReadonlySet<string>;
    readonly fail?: ReadonlySet<string>;
    readonly deletes?: number;
  } = {},
) {
  const entered: PersonalAuthority[] = [];
  const pruned: { universeId: string; limit: number }[] = [];
  const asked: { limit: number; lookbackDays?: number; after?: DecisionScanKey }[] = [];
  return {
    entered,
    pruned,
    asked,
    ports: {
      findOwners: (input: { limit: number; lookbackDays?: number; after?: DecisionScanKey }) => {
        asked.push(input);
        return Promise.resolve({ owners });
      },
      withPersonalScope: async <T>(
        authority: PersonalAuthority,
        work: (scope: PersonalScopeTx) => Promise<T>,
      ): Promise<ScopeOutcome<T>> => {
        entered.push(authority);
        if (behaviour.fail?.has(authority.universeId)) throw new Error('SCOPE_BUSY');
        if (behaviour.refuse?.has(authority.universeId)) return { kind: 'refused', reason: 'epoch_changed' } as never;
        return { kind: 'entered', value: await work({ authority } as unknown as PersonalScopeTx) };
      },
      prune: (scope: PersonalScopeTx, limit: number) => {
        pruned.push({ universeId: scope.authority.universeId, limit });
        return Promise.resolve(behaviour.deletes ?? 3);
      },
    },
  };
}

describe('the scheduled decision prune', () => {
  it('asks for a bounded number of universes and prunes each in its own scope, as a system actor, in a bounded batch', async () => {
    const fake = ports([owner(1), owner(2)]);
    const result = await makePruneDecisions(fake.ports)();
    expect(fake.asked).toEqual([{ limit: PRUNE_DECISIONS.universes, lookbackDays: PRUNE_DECISIONS.lookbackDays }]);
    expect(fake.entered.map((a) => a.actor)).toEqual([
      { kind: 'system', purpose: 'composer.prune-decisions' },
      { kind: 'system', purpose: 'composer.prune-decisions' },
    ]);
    expect(fake.pruned).toEqual([
      { universeId: 'universe-1', limit: PRUNE_DECISIONS.batch },
      { universeId: 'universe-2', limit: PRUNE_DECISIONS.batch },
    ]);
    expect(result).toEqual({ deleted: 6, universes: 2, failed: 0 });
  });

  it('keeps every bound within what `pruneComposerDecisions` accepts', () => {
    expect(PRUNE_DECISIONS.batch).toBeGreaterThanOrEqual(1);
    expect(PRUNE_DECISIONS.batch).toBeLessThanOrEqual(1000);
    expect(PRUNE_DECISIONS.universes).toBeGreaterThan(0);
  });

  it('does nothing when no universe has an expired decision', async () => {
    const fake = ports([]);
    expect(await makePruneDecisions(fake.ports)()).toEqual({ deleted: 0, universes: 0, failed: 0 });
    expect(fake.entered).toEqual([]);
  });

  it('skips a universe the root refuses (gone, suspended, a new epoch) without counting it as a failure', async () => {
    const fake = ports([owner(1), owner(2)], { refuse: new Set(['universe-1']) });
    expect(await makePruneDecisions(fake.ports)()).toEqual({ deleted: 3, universes: 2, failed: 0 });
    expect(fake.pruned.map((p) => p.universeId)).toEqual(['universe-2']);
  });

  it('leaves a busy or failing universe for the next pass and still prunes the others', async () => {
    const fake = ports([owner(1), owner(2), owner(3)], { fail: new Set(['universe-2']) });
    expect(await makePruneDecisions(fake.ports)()).toEqual({ deleted: 6, universes: 3, failed: 1 });
    expect(fake.pruned.map((p) => p.universeId)).toEqual(['universe-1', 'universe-3']);
  });
});

describe('the backfill: a one-off pass with no lookback', () => {
  const key = (n: number): DecisionScanKey => ({
    expiresAt: `2026-09-0${String(n)} 10:00:00+00`,
    id: `id-${String(n)}`,
  });

  /** Pages of owners the fake scan returns in turn, each with the key to continue from (the last page has none). */
  function paged(
    pages: readonly (readonly ExpiredDecisionsOwner[])[],
    options: { readonly removedPerBatch?: (universeId: string, batch: number) => number } = {},
  ) {
    const asked: { limit: number; lookbackDays?: number; after?: DecisionScanKey }[] = [];
    const batches = new Map<string, number>();
    return {
      asked,
      batches,
      ports: {
        findOwners: (input: { limit: number; lookbackDays?: number; after?: DecisionScanKey }) => {
          asked.push(input);
          const index = asked.length - 1;
          return Promise.resolve({
            owners: pages[index] ?? [],
            ...(index < pages.length - 1 ? { next: key(index + 1) } : {}),
          });
        },
        withPersonalScope: async <T>(
          authority: PersonalAuthority,
          work: (scope: PersonalScopeTx) => Promise<T>,
        ): Promise<ScopeOutcome<T>> => ({
          kind: 'entered',
          value: await work({ authority } as unknown as PersonalScopeTx),
        }),
        prune: (scope: PersonalScopeTx) => {
          const universe = scope.authority.universeId;
          const batch = batches.get(universe) ?? 0;
          batches.set(universe, batch + 1);
          return Promise.resolve(options.removedPerBatch?.(universe, batch) ?? 0);
        },
      },
    };
  }

  it('scans with no lookback, page after page past the last key read, until the scan ends', async () => {
    const fake = paged([[owner(1)], [owner(2)], [owner(3)]]);
    const result = await makeBackfillPruneDecisions(fake.ports)({ maxUniverses: 100 });
    expect(fake.asked).toEqual([
      { limit: PRUNE_DECISIONS.universes },
      { limit: PRUNE_DECISIONS.universes, after: key(1) },
      { limit: PRUNE_DECISIONS.universes, after: key(2) },
    ]);
    expect(fake.asked.every((ask) => ask.lookbackDays === undefined)).toBe(true);
    expect(result).toEqual({ deleted: 0, universes: 3, failed: 0, complete: true });
  });

  it('prunes a universe in bounded batches until a batch comes back short, and never more than the batch cap', async () => {
    const fake = paged([[owner(1), owner(2)]], {
      // Universe 1 has two full batches and a short one; universe 2 would never run short.
      removedPerBatch: (universe, batch) =>
        universe === 'universe-1' ? (batch < 2 ? PRUNE_DECISIONS.batch : 7) : PRUNE_DECISIONS.batch,
    });
    const result = await makeBackfillPruneDecisions(fake.ports)({ maxUniverses: 100 });
    expect(fake.batches.get('universe-1')).toBe(3);
    expect(fake.batches.get('universe-2')).toBe(PRUNE_DECISIONS.backfillBatchesPerUniverse);
    expect(result.deleted).toBe(
      2 * PRUNE_DECISIONS.batch + 7 + PRUNE_DECISIONS.backfillBatchesPerUniverse * PRUNE_DECISIONS.batch,
    );
  });

  it('stops after the most universes asked for and says it is not complete, so it can be run again', async () => {
    const fake = paged([[owner(1), owner(2), owner(3)], [owner(4)]]);
    const result = await makeBackfillPruneDecisions(fake.ports)({ maxUniverses: 2 });
    expect(result).toMatchObject({ universes: 2, complete: false });
    expect(fake.batches.has('universe-3')).toBe(false);
  });

  it('keeps going past a universe that fails or is refused, and counts only the failure', async () => {
    const fake = paged([[owner(1), owner(2)]]);
    const throwing = {
      ...fake.ports,
      withPersonalScope: async <T>(
        authority: PersonalAuthority,
        work: (scope: PersonalScopeTx) => Promise<T>,
      ): Promise<ScopeOutcome<T>> => {
        if (authority.universeId === 'universe-1') throw new Error('SCOPE_BUSY');
        return fake.ports.withPersonalScope(authority, work);
      },
    };
    expect(await makeBackfillPruneDecisions(throwing)({ maxUniverses: 100 })).toEqual({
      deleted: 0,
      universes: 2,
      failed: 1,
      complete: true,
    });
  });

  it('is complete on an empty scan', async () => {
    expect(await makeBackfillPruneDecisions(paged([[]]).ports)({ maxUniverses: 5 })).toEqual({
      deleted: 0,
      universes: 0,
      failed: 0,
      complete: true,
    });
  });
});
