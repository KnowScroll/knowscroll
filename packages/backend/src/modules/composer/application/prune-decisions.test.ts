import { describe, expect, it } from 'vitest';
import type { PersonalAuthority, PersonalScopeTx, ScopeOutcome } from '../../identity/public.js';
import { PRUNE_DECISIONS, makePruneDecisions, type ExpiredDecisionsOwner } from './prune-decisions.js';

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
  const asked: { limit: number; lookbackDays: number }[] = [];
  return {
    entered,
    pruned,
    asked,
    ports: {
      findOwners: (input: { limit: number; lookbackDays: number }) => {
        asked.push(input);
        return Promise.resolve(owners);
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
