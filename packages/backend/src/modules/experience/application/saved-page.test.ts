import { describe, expect, it, vi } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { makeSavedPage, type SavedPagePorts, type SavedCandidate } from './saved-page.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority = { universeId: id(1), privacyEpoch: 2, actor: { kind: 'account' as const, accountId: id(2) } };
const request = { pagination: 'saved-page.v1', filter: 'all', limit: '20' };
const token = `ksp1_${'a'.repeat(70)}`,
  next = `ksp1_${'b'.repeat(70)}`;
function fixture(size = 100, more = true) {
  const scope = { authority, revisionAtEntry: 4 } as unknown as PersonalScopeTx;
  const candidates: SavedCandidate[] = Array.from({ length: size }, (_, i) => ({
    entry: { assetId: id(100 + i), assetRevision: 1, savedEntryId: id(1000 + i) },
    key: { assetId: id(100 + i), savedAt: '2026-10-22T10:00:00.123456Z' },
  }));
  const order: string[] = [];
  const p: { -readonly [K in keyof SavedPagePorts]: SavedPagePorts[K] } = {
    withScope: async (_, work) => ({ kind: 'entered', value: await work(scope) }),
    fenceOwn: vi.fn<SavedPagePorts['fenceOwn']>(() => {
      order.push('account');
      return Promise.resolve({ kind: 'active', owner: { accountId: id(2), universeId: id(1), privacyEpoch: 2 } });
    }),
    codec: {
      read: vi.fn(() => {
        order.push('cursor');
        return candidates[0]?.key;
      }),
      mint: vi.fn(() => next),
    },
    candidates: vi.fn(() => Promise.resolve({ items: candidates, more })),
    metadata: vi.fn<SavedPagePorts['metadata']>((_, refs) =>
      Promise.resolve(refs.map((ref) => ({ ref, kind: 'reel' as const, availability: 'withdrawn' as const }))),
    ),
  };
  return { p, read: () => makeSavedPage(p), candidates, order };
}
describe('current scoped bounded Saved pages', () => {
  it('fences current account before decoding, stops exactly at requested output and retains cursor binding', async () => {
    const f = fixture(),
      result = await f.read()(authority, { ...request, cursor: token });
    expect(f.order).toEqual(['account', 'cursor']);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected page');
    expect(result.value.items).toHaveLength(20);
    expect(result.value.requestCursor).toBe(token);
    expect(result.value.continuation).toEqual({ status: 'more', cursor: next });
    expect(f.p.codec.mint).toHaveBeenCalledWith(
      { accountId: id(2), universeId: id(1), privacyEpoch: 2, filter: 'all', limit: 20 },
      f.candidates[19]!.key,
    );
  });
  it('can consume a nonmatching100-candidate window and continue without claiming an empty library', async () => {
    const f = fixture(),
      result = await f.read()(authority, { ...request, filter: 'scroll' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected page');
    expect(result.value.items).toEqual([]);
    expect(result.value.continuation.status).toBe('more');
    expect(f.p.codec.mint).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'scroll', limit: 20 }),
      f.candidates[99]!.key,
    );
    expect(f.p.metadata).toHaveBeenCalledWith(
      expect.anything(),
      f.candidates.map((item) => ({ assetId: item.entry.assetId, assetRevision: item.entry.assetRevision })),
    );
  });
  it('rechecks authority before unavailable cursors and never reads domain facts on refusal', async () => {
    const f = fixture();
    f.p.fenceOwn = vi.fn<SavedPagePorts['fenceOwn']>(() => Promise.resolve({ kind: 'unavailable' }));
    expect(await f.read()(authority, { ...request, cursor: token })).toEqual({
      kind: 'refused',
      code: 'UNIVERSE_UNAVAILABLE',
    });
    expect(f.p.codec.read).not.toHaveBeenCalled();
    expect(f.p.candidates).not.toHaveBeenCalled();
  });
  it('refuses unknown cursors and excessive/misaligned port results without silently adopting facts', async () => {
    const f = fixture();
    f.p.codec.read = vi.fn(() => undefined);
    expect(await f.read()(authority, { ...request, cursor: token })).toEqual({
      kind: 'refused',
      code: 'SAVED_CURSOR_UNAVAILABLE',
    });
    expect(f.p.candidates).not.toHaveBeenCalled();
    const oversized = fixture(101);
    expect(await oversized.read()(authority, request)).toEqual({ kind: 'refused', code: 'SERVICE_UNAVAILABLE' });
    const wrong = fixture(1, false);
    wrong.p.metadata = vi.fn<SavedPagePorts['metadata']>(() =>
      Promise.resolve([{ ref: { assetId: id(9), assetRevision: 1 }, kind: 'reel', availability: 'withdrawn' }]),
    );
    expect(await wrong.read()(authority, request)).toEqual({ kind: 'refused', code: 'SERVICE_UNAVAILABLE' });
  });
  it('does not inspect cursors for an epoch/barrier refusal or invalid wire shape', async () => {
    const f = fixture();
    f.p.withScope = () =>
      Promise.resolve({
        kind: 'refused',
        refusal: { kind: 'epoch_changed', currentEpoch: 3 },
      });
    expect(await f.read()(authority, { ...request, cursor: token })).toEqual({
      kind: 'refused',
      code: 'PRIVACY_EPOCH_CHANGED',
    });
    expect(f.p.codec.read).not.toHaveBeenCalled();
    expect(await f.read()(authority, { ...request, limit: '51' })).toEqual({
      kind: 'refused',
      code: 'INVALID_REQUEST',
    });
  });
  it('ends a truly exhausted window and rejects a codec that loops the initiating cursor', async () => {
    const f = fixture(3, false);
    const result = await f.read()(authority, request);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected exhausted page');
    expect(result.value.items).toHaveLength(3);
    expect(result.value.continuation).toEqual({ status: 'end' });
    const loop = fixture();
    loop.p.codec.mint = vi.fn(() => token);
    expect(await loop.read()(authority, { ...request, cursor: token })).toEqual({
      kind: 'refused',
      code: 'SERVICE_UNAVAILABLE',
    });
    const last = fixture(0, false);
    expect(await last.read()(authority, request)).toMatchObject({
      kind: 'ok',
      value: { items: [], continuation: { status: 'end' } },
    });
  });
});
