import { describe, expect, it } from 'vitest';
import { canaryAddressFor, canaryAddressShape } from '../../domain/canary/personas.js';
import { cleanupCanary } from './cleanup-canary.js';
import type { CanaryApi, CanaryPorts, MintResult } from './ports.js';

const shape = canaryAddressShape('*@test.knowscroll.space')!;
const mine = (run: string, persona: 'cold-start' | 'deep-reader' = 'cold-start') =>
  canaryAddressFor('*@test.knowscroll.space', run, persona)!;

/** A world holding the accounts of a disposable-address list: which were minted, signed in and deleted. */
function world(addresses: readonly string[], options: { readonly stuck?: ReadonlySet<string> } = {}) {
  const seen = { listed: 0, minted: [] as string[], deleted: [] as string[] };
  let now = 0;
  const ports: CanaryPorts = {
    accounts: {
      listCanaryAddresses: () => {
        seen.listed += 1;
        return Promise.resolve(addresses);
      },
      mint: (address): Promise<MintResult> => {
        seen.minted.push(address);
        return Promise.resolve({ kind: 'issued', link: address });
      },
      signIn: (link) =>
        Promise.resolve({
          account: { accountId: link, universeId: link, privacyEpoch: 1 },
          deleteAccount: () => Promise.resolve(),
          deletionState: () => {
            if (options.stuck?.has(link) === true) return Promise.resolve('in_progress' as const);
            if (!seen.deleted.includes(link)) seen.deleted.push(link);
            return Promise.resolve('completed' as const);
          },
          retryDeletion: () => Promise.resolve(),
        } as unknown as CanaryApi),
    },
    reads: { read: () => Promise.reject(new Error('not used')), evidence: () => Promise.reject(new Error('not used')) },
    pacer: {
      nowMs: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    },
    newId: () => 'receipt',
  };
  return { ports, seen };
}

describe('cleanupCanary', () => {
  it('deletes exactly the addresses the canary makes, and opens no other test account', async () => {
    const strangers = [
      'alice@test.knowscroll.space',
      'canary-notarun-cold-start@test.knowscroll.space',
      'canary-ab12cd34-intruder@test.knowscroll.space',
      'canary-ab12cd34-cold-start@elsewhere.example',
    ];
    const { ports, seen } = world([mine('ab12cd34'), ...strangers, mine('ab12cd34', 'deep-reader'), mine('00ff00ff')]);
    const report = await cleanupCanary(ports, shape, { dryRun: false });
    expect(report).toEqual({ found: 3, runs: 2, deleted: 3, failed: 0, stopped: false });
    expect(seen.minted.sort()).toEqual([mine('00ff00ff'), mine('ab12cd34'), mine('ab12cd34', 'deep-reader')].sort());
    for (const stranger of strangers) expect(seen.minted).not.toContain(stranger);
  });

  it('limits itself to one run when asked', async () => {
    const { ports, seen } = world([mine('ab12cd34'), mine('ab12cd34', 'deep-reader'), mine('00ff00ff')]);
    const report = await cleanupCanary(ports, shape, { run: '00ff00ff', dryRun: false });
    expect(report).toMatchObject({ found: 1, runs: 1, deleted: 1 });
    expect(seen.minted).toEqual([mine('00ff00ff')]);
  });

  it('only counts on a dry run: nothing is minted, signed in or deleted', async () => {
    const { ports, seen } = world([mine('ab12cd34'), mine('00ff00ff')]);
    expect(await cleanupCanary(ports, shape, { dryRun: true })).toEqual({
      found: 2,
      runs: 2,
      deleted: 0,
      failed: 0,
      stopped: false,
    });
    expect(seen.minted).toEqual([]);
  });

  it('reports an account whose deletion did not finish, and the mint a refusal of the operator pattern', async () => {
    const stuck = new Set([mine('ab12cd34')]);
    const { ports } = world([mine('ab12cd34'), mine('00ff00ff')], { stuck });
    expect(await cleanupCanary(ports, shape, { dryRun: false })).toMatchObject({ found: 2, deleted: 1, failed: 1 });
    const refusing = world([mine('ab12cd34')]);
    const refused = await cleanupCanary(
      {
        ...refusing.ports,
        accounts: {
          ...refusing.ports.accounts,
          mint: () => Promise.resolve({ kind: 'refused', reason: 'not_disposable' }),
        },
      },
      shape,
      { dryRun: false },
    );
    expect(refused).toMatchObject({ found: 1, deleted: 0, failed: 1 });
  });

  it('stops starting accounts once it is told to stop, and says so', async () => {
    const { ports, seen } = world([mine('ab12cd34'), mine('00ff00ff')]);
    const controller = new AbortController();
    controller.abort('sigint');
    expect(await cleanupCanary(ports, shape, { dryRun: false }, controller.signal)).toMatchObject({
      found: 2,
      deleted: 0,
      failed: 2,
      stopped: true,
    });
    expect(seen.minted).toEqual([]);
  });
});
