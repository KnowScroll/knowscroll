import { waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import type { SetKeepPlace } from '@knowscroll/contracts';
import { createKeepView, keepBridgeFor, refreshKeep, sameKeep, type AvailableKeep } from './keep-place-bridge';

// Expo's native Jest mock intentionally returns no UUID. This labelled fixture supplies valid command IDs only.
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const target = { assetId: id(3), assetRevision: 1 };
const snapshot = (membership = id(4), revision = 1): AvailableKeep => ({
  version: 'keep-place.v1',
  scope: { accountId: id(1), privacyEpoch: 1 },
  target,
  status: 'available',
  entry: { ...target, savedEntryId: membership },
  place:
    revision === 0
      ? { status: 'none', placeRevision: 0 }
      : { status: 'set', placeRevision: revision, position: { kind: 'reel', positionMs: 1234.5 } },
});
const scopes: AccountScope[] = [];
afterEach(() => {
  for (const s of scopes) s.end();
  scopes.length = 0;
});
function fixture(handler?: (body: Record<string, unknown>, path: string) => unknown) {
  const calls: { body: Record<string, unknown>; path: string }[] = [];
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'keep@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      calls.push({ body, path });
      return json(handler ? await handler(body, path) : snapshot());
    },
  });
  scopes.push(scope);
  return { scope, calls };
}
describe('mounted Keep bridge using the real bounded client session', () => {
  it('owns at most sixty-four handles and balances repeated effect starts/stops without creating effects', async () => {
    const f = fixture();
    const view = createKeepView(f.scope, target);
    view.start();
    view.start();
    await waitFor(() => expect(view.getState().status).toBe('ready'));
    const others = Array.from({ length: 63 }, () => keepBridgeFor(f.scope).retain(target)!);
    expect(others.every(Boolean)).toBe(true);
    expect(keepBridgeFor(f.scope).retain(target)).toBeUndefined();
    view.stop();
    view.stop();
    view.start();
    await waitFor(() => expect(view.getState().status).toBe('ready'));
    expect(f.calls.every((c) => c.path.endsWith('/keep/read'))).toBe(true);
    others.forEach((handle) => handle.release());
    view.stop();
    const next = keepBridgeFor(f.scope).retain(target);
    expect(next).toBeDefined();
    next?.release();
  });
  it('requires a later read rather than treating cached state or a write ACK as fresh authority', async () => {
    let release!: (value: unknown) => void;
    let gated = false;
    const f = fixture(() =>
      gated
        ? new Promise((resolve) => {
            release = resolve;
          })
        : snapshot(),
    );
    const h = keepBridgeFor(f.scope).retain(target)!;
    await waitFor(() => expect(h.getState().status).toBe('ready'));
    gated = true;
    const fresh = refreshKeep(f.scope, h);
    let finished = false;
    void fresh.then(() => {
      finished = true;
    });
    await waitFor(() => expect(release).toBeDefined());
    expect(finished).toBe(false);
    release(snapshot(id(5), 0));
    expect((await fresh).entry.savedEntryId).toBe(id(5));
    h.release();
  });
  it('purges synchronously and rejects an abort-ignoring late read across identical textual scopes', async () => {
    let release!: (value: unknown) => void;
    const f = fixture(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const h = keepBridgeFor(f.scope).retain(target)!;
    const fresh = refreshKeep(f.scope, h);
    const refused = expect(fresh).rejects.toThrow('keep_unavailable');
    await waitFor(() => expect(release).toBeDefined());
    f.scope.end();
    expect(h.getState().status).toBe('ended');
    await refused;
    release(snapshot());
    const other = fixture();
    expect(other.scope.id).toBe(f.scope.id);
    expect(keepBridgeFor(other.scope)).not.toBe(keepBridgeFor(f.scope));
    const live = keepBridgeFor(other.scope).retain(target)!;
    await waitFor(() => expect(live.getState().status).toBe('ready'));
    expect(h.getState().snapshot).toBeUndefined();
    live.release();
  });
  it('compares membership and exact scope/ref before revision, including ABA reset', () => {
    expect(sameKeep(snapshot(id(4), 9), snapshot(id(5), 1))).toBe(false);
    expect(sameKeep(snapshot(), { ...snapshot(), scope: { accountId: id(9), privacyEpoch: 1 } })).toBe(false);
    expect(sameKeep(snapshot(), snapshot())).toBe(true);
  });
  it('preserves a lost-ACK command across release and explicit same-membership retry only', async () => {
    let failures = true;
    const sent: SetKeepPlace[] = [];
    let revision = 1;
    const f = fixture((body, path) => {
      if (path.endsWith('/read')) return snapshot(id(4), revision);
      const b = body as unknown as SetKeepPlace;
      sent.push(b);
      if (failures) throw new Error('labelled unknown fixture');
      revision = b.expectedPlaceRevision + 1;
      return {
        version: 'keep-place.v1',
        scope: snapshot().scope,
        commandId: b.commandId,
        recordedAt: '2026-10-22T00:00:00.000Z',
        replayed: true,
        outcome: 'accepted',
        operation: 'keep.place.set',
        entry: b.entry,
        basePlaceRevision: b.expectedPlaceRevision,
        acceptedPlaceRevision: revision,
      };
    });
    const h = keepBridgeFor(f.scope).retain(target)!;
    await waitFor(() => expect(h.getState().status).toBe('ready'));
    expect(h.setPosition({ kind: 'reel', positionMs: 31.25 })).toBe(true);
    await waitFor(() => expect(h.getState().write).toBe('unknown'));
    h.release();
    failures = false;
    const again = keepBridgeFor(f.scope).retain(target)!;
    await waitFor(() => expect(again.getState().write).toBe('unknown'));
    expect(sent).toHaveLength(1);
    expect(again.retry()).toBe(true);
    await waitFor(() => expect(again.getState().write).toBe('idle'));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(again.getState().snapshot?.status).toBe('available');
    again.release();
  });
});
