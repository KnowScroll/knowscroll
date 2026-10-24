import { describe, expect, it, vi } from 'vitest';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import {
  makeSetNotInterested,
  makeUndoNotInterested,
  type NotInterestedPorts,
  type NotInterestedStore,
} from './not-interested.js';
import type { CommandKey, CommandLookup } from './ports.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 1,
  actor: { kind: 'account', accountId: id(2) },
};
const scope = { authority } as unknown as PersonalScopeTx;
const assetId = id(10);
const expiresAt = new Date('2026-11-07T12:00:00.000Z');

/** Ports over memory: one receipt per command ID, a set of marked assets, and a log of what was written. */
function fixture(overrides: { lookup?: CommandLookup; admitted?: boolean; scopeRefusal?: 'epoch_changed' } = {}) {
  const receipts = new Map<string, { key: CommandKey; outcome?: Record<string, unknown> }>();
  const marked = new Set<string>();
  const store: NotInterestedStore = {
    mark: vi.fn((_scope, asset: string) => {
      marked.add(asset);
      return Promise.resolve(expiresAt);
    }),
    unmark: vi.fn((_scope, asset: string) => {
      marked.delete(asset);
      return Promise.resolve();
    }),
  };
  const withPersonalScope: WithPersonalScope = (_authority, work) =>
    overrides.scopeRefusal
      ? Promise.resolve({ kind: 'refused', refusal: { kind: overrides.scopeRefusal } } as never)
      : work(scope).then((value) => ({ kind: 'entered', value }));
  const findAsset = vi.fn(() =>
    Promise.resolve(overrides.admitted === false ? { revision: 1, admitted: false } : { revision: 1, admitted: true }),
  );
  const ports: NotInterestedPorts = {
    withPersonalScope,
    hashRequest: (operation, request) => `${operation}:${JSON.stringify(request)}`,
    findReceipt: (_scope, key) => {
      if (overrides.lookup) return Promise.resolve(overrides.lookup);
      const stored = receipts.get(key.commandId);
      if (!stored) return Promise.resolve({ kind: 'new' });
      if (stored.key.requestHash !== key.requestHash) return Promise.resolve({ kind: 'key_reused' });
      return Promise.resolve({ kind: 'replay', outcome: stored.outcome });
    },
    insertReceipt: (_scope, key) => {
      receipts.set(key.commandId, { key });
      return Promise.resolve();
    },
    completeReceipt: (_scope, commandId, outcome) => {
      receipts.get(commandId)!.outcome = outcome;
      return Promise.resolve();
    },
    findAsset,
    store,
  };
  return { ports, store, marked, receipts, findAsset };
}

describe('Not interested', () => {
  it('marks an admitted asset and answers when it lapses', async () => {
    const { ports, marked } = fixture();
    const result = await makeSetNotInterested(ports)(authority, { commandId: id(20), assetId });
    expect(result).toEqual({
      kind: 'applied',
      outcome: { commandId: id(20), assetId, expiresAt: expiresAt.toISOString(), replayed: false },
    });
    expect(marked.has(assetId)).toBe(true);
  });

  it('answers an identical retry from the receipt and marks nothing twice', async () => {
    const { ports, store } = fixture();
    const set = makeSetNotInterested(ports);
    await set(authority, { commandId: id(20), assetId });
    const again = await set(authority, { commandId: id(20), assetId });
    expect(again).toMatchObject({ kind: 'applied', outcome: { replayed: true, assetId } });
    expect(store.mark).toHaveBeenCalledTimes(1);
  });

  it('refuses a command ID used for another asset', async () => {
    const { ports } = fixture();
    const set = makeSetNotInterested(ports);
    await set(authority, { commandId: id(20), assetId });
    expect(await set(authority, { commandId: id(20), assetId: id(11) })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
  });

  it('writes nothing for an asset that is not admitted', async () => {
    const { ports, receipts, store } = fixture({ admitted: false });
    expect(await makeSetNotInterested(ports)(authority, { commandId: id(20), assetId })).toEqual({
      kind: 'refused',
      reason: 'asset_not_found',
    });
    expect(receipts.size).toBe(0);
    expect(store.mark).not.toHaveBeenCalled();
  });

  it('never re-applies an outcome a newer release stored, and asks for a new ID after a reset', async () => {
    const newer = fixture({ lookup: { kind: 'outcome_version_newer' } });
    expect(await makeSetNotInterested(newer.ports)(authority, { commandId: id(20), assetId })).toEqual({
      kind: 'refused',
      reason: 'outcome_from_newer_release',
    });
    const reset = fixture({ lookup: { kind: 'epoch_mismatch' } });
    expect(await makeSetNotInterested(reset.ports)(authority, { commandId: id(20), assetId })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    expect(newer.store.mark).not.toHaveBeenCalled();
    expect(reset.store.mark).not.toHaveBeenCalled();
  });

  it('names a privacy reset or an unavailable universe when the scope refuses', async () => {
    const changed = fixture({ scopeRefusal: 'epoch_changed' });
    expect(await makeSetNotInterested(changed.ports)(authority, { commandId: id(20), assetId })).toEqual({
      kind: 'refused',
      reason: 'epoch_changed',
    });
  });

  it('undoes without looking at the asset, so withdrawn content can still be taken back', async () => {
    const { ports, marked, findAsset } = fixture({ admitted: false });
    marked.add(assetId);
    const result = await makeUndoNotInterested(ports)(authority, { commandId: id(21), assetId });
    expect(result).toEqual({ kind: 'applied', outcome: { commandId: id(21), assetId, replayed: false } });
    expect(marked.has(assetId)).toBe(false);
    expect(findAsset).not.toHaveBeenCalled();
  });

  it('undoes what is not marked, and answers a retry from the receipt', async () => {
    const { ports, store } = fixture();
    const undo = makeUndoNotInterested(ports);
    expect(await undo(authority, { commandId: id(21), assetId })).toMatchObject({ kind: 'applied' });
    expect(await undo(authority, { commandId: id(21), assetId })).toMatchObject({
      kind: 'applied',
      outcome: { replayed: true },
    });
    expect(store.unmark).toHaveBeenCalledTimes(1);
  });

  it('keeps Undo and the mark apart: one command ID cannot be both', async () => {
    const { ports } = fixture();
    await makeSetNotInterested(ports)(authority, { commandId: id(20), assetId });
    expect(await makeUndoNotInterested(ports)(authority, { commandId: id(20), assetId })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
  });
});
