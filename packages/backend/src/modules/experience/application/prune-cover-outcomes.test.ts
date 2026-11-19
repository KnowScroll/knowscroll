import { describe, expect, it } from 'vitest';
import type { PersonalAuthority, PersonalScopeTx, ScopeOutcome } from '../../identity/public.js';
import {
  PRUNE_COVER_OUTCOMES_BOUNDS,
  makePruneCoverOutcomes,
  type ExpiredCoverOutcomesOwner,
} from './prune-cover-outcomes.js';

const owner = (n: number): ExpiredCoverOutcomesOwner => ({ universeId: `universe-${String(n)}`, privacyEpoch: 1 });

/** Fake ports: records who was pruned and with what bound, and lets a test refuse or break a universe. */
function ports(
  owners: readonly ExpiredCoverOutcomesOwner[],
  behaviour: { readonly refuse?: ReadonlySet<string>; readonly fail?: ReadonlySet<string> } = {},
) {
  const entered: PersonalAuthority[] = [];
  const pruned: { universeId: string; limit: number }[] = [];
  const asked: { limit: number }[] = [];
  return {
    entered,
    pruned,
    asked,
    ports: {
      findOwners: (input: { limit: number }) => {
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
        return Promise.resolve(3);
      },
    },
  };
}

describe('the scheduled cover-outcome prune', () => {
  it('asks for a bounded number of universes and prunes each in its own scope, as a system actor, in a bounded batch', async () => {
    const fake = ports([owner(1), owner(2)]);
    expect(await makePruneCoverOutcomes(fake.ports)()).toEqual({ deleted: 6, universes: 2, failed: 0 });
    expect(fake.asked).toEqual([{ limit: PRUNE_COVER_OUTCOMES_BOUNDS.universes }]);
    expect(fake.entered.map((authority) => authority.actor)).toEqual([
      { kind: 'system', purpose: 'experience.prune-cover-outcomes' },
      { kind: 'system', purpose: 'experience.prune-cover-outcomes' },
    ]);
    expect(fake.pruned.map((entry) => entry.limit)).toEqual([
      PRUNE_COVER_OUTCOMES_BOUNDS.batch,
      PRUNE_COVER_OUTCOMES_BOUNDS.batch,
    ]);
  });

  it('keeps the batch within what the store accepts', () => {
    expect(PRUNE_COVER_OUTCOMES_BOUNDS.batch).toBeGreaterThanOrEqual(1);
    expect(PRUNE_COVER_OUTCOMES_BOUNDS.batch).toBeLessThanOrEqual(1000);
  });

  it('does nothing when no universe has an expired row', async () => {
    const fake = ports([]);
    expect(await makePruneCoverOutcomes(fake.ports)()).toEqual({ deleted: 0, universes: 0, failed: 0 });
    expect(fake.entered).toEqual([]);
  });

  it('skips a universe the root refuses without counting a failure', async () => {
    const fake = ports([owner(1), owner(2)], { refuse: new Set(['universe-1']) });
    expect(await makePruneCoverOutcomes(fake.ports)()).toEqual({ deleted: 3, universes: 2, failed: 0 });
    expect(fake.pruned.map((entry) => entry.universeId)).toEqual(['universe-2']);
  });

  it('leaves a busy or failing universe for the next pass and still prunes the others', async () => {
    const fake = ports([owner(1), owner(2), owner(3)], { fail: new Set(['universe-2']) });
    expect(await makePruneCoverOutcomes(fake.ports)()).toEqual({ deleted: 6, universes: 3, failed: 1 });
    expect(fake.pruned.map((entry) => entry.universeId)).toEqual(['universe-1', 'universe-3']);
  });
});
