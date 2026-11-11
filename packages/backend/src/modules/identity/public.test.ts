import { describe, expect, it } from 'vitest';
import {
  withScopeAtCurrentEpoch,
  type PersonalAuthority,
  type PersonalScopeTx,
  type ScopeOutcome,
  type ScopeRefusal,
  type WithDryRunPersonalScope,
  type WithPersonalScope,
} from './public.js';

const UNIVERSE = '11111111-1111-4111-8111-111111111111';

/** A scope that answers from a table: the universe's real epoch, or a refusal; it records the epochs claimed. */
function scope(current: number | ScopeRefusal) {
  const claimed: number[] = [];
  const withScope = (async <T>(
    authority: PersonalAuthority,
    work: (scope: PersonalScopeTx) => Promise<T>,
  ): Promise<ScopeOutcome<T>> => {
    claimed.push(authority.privacyEpoch);
    if (typeof current !== 'number') return { kind: 'refused', refusal: current };
    if (authority.privacyEpoch !== current)
      return { kind: 'refused', refusal: { kind: 'epoch_changed', currentEpoch: current } };
    return { kind: 'entered', value: await work({ authority } as unknown as PersonalScopeTx) };
  }) as unknown as WithDryRunPersonalScope;
  return { withScope, claimed };
}

describe('entering a universe named without its epoch (D-411)', () => {
  it('enters at epoch 1 at once when that is the current one', async () => {
    const { withScope, claimed } = scope(1);
    expect(
      await withScopeAtCurrentEpoch(withScope, UNIVERSE, 'ci', (s) => Promise.resolve(s.authority.privacyEpoch)),
    ).toEqual({
      kind: 'entered',
      value: 1,
    });
    expect(claimed).toEqual([1]);
  });

  it('claims the epoch it is told is current, as a system actor, and runs the work once', async () => {
    const { withScope, claimed } = scope(4);
    let runs = 0;
    const outcome = await withScopeAtCurrentEpoch(withScope, UNIVERSE, 'geography.dry-run', (s) => {
      runs += 1;
      return Promise.resolve(s.authority);
    });
    expect(claimed).toEqual([1, 4]);
    expect(runs).toBe(1);
    expect(outcome).toEqual({
      kind: 'entered',
      value: { universeId: UNIVERSE, privacyEpoch: 4, actor: { kind: 'system', purpose: 'geography.dry-run' } },
    });
  });

  it('asks only once more for any other refusal, and never runs the work', async () => {
    for (const kind of ['universe_missing', 'universe_suspended', 'account_mismatch'] as const) {
      const { withScope, claimed } = scope({ kind });
      let runs = 0;
      expect(
        await withScopeAtCurrentEpoch(withScope, UNIVERSE, 'ci', () => {
          runs += 1;
          return Promise.resolve(0);
        }),
      ).toEqual({ kind: 'refused', refusal: { kind } });
      expect(claimed).toEqual([1]);
      expect(runs).toBe(0);
    }
  });

  it('takes only a scope made read-only, never an ordinary one that can write', () => {
    const ordinary = (() => Promise.reject(new Error('CI never runs this'))) as unknown as WithPersonalScope;
    const enter = () =>
      withScopeAtCurrentEpoch(
        // @ts-expect-error a scope that can commit a write is not a dry-run scope
        ordinary,
        UNIVERSE,
        'ci',
        () => Promise.resolve(0),
      );
    expect(typeof enter).toBe('function');
  });
});
