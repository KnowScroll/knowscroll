import { afterEach, describe, expect, it, vi } from 'vitest';
import { problemDetails, type KeepAssetRef, type KeepEntryRef, type SetKeepPlace } from '@knowscroll/contracts';
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';
import { createKeepPlaceSession, KEEP_PLACE_LIMITS, type KeepPlaceHandle } from './keep-place';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'keep@fixture.test' };
const target = { assetId: id(3), assetRevision: 1 };
const originalEntry = { ...target, savedEntryId: id(4) };
const scopes: AccountScope[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function snapshot(entry = originalEntry, revision = 0, positionMs = 0) {
  return {
    version: 'keep-place.v1',
    scope: { accountId: account.accountId, privacyEpoch: 1 },
    target: { assetId: entry.assetId, assetRevision: entry.assetRevision },
    status: 'available',
    entry,
    place:
      revision === 0
        ? { status: 'none', placeRevision: 0 }
        : { status: 'set', placeRevision: revision, position: { kind: 'reel', positionMs } },
  };
}
function acceptance(body: SetKeepPlace, replayed = false) {
  return {
    version: 'keep-place.v1',
    scope: { accountId: account.accountId, privacyEpoch: 1 },
    commandId: body.commandId,
    recordedAt: '2026-10-21T00:00:00.000Z',
    replayed,
    outcome: 'accepted',
    operation: 'keep.place.set',
    entry: body.entry,
    basePlaceRevision: body.expectedPlaceRevision,
    acceptedPlaceRevision: body.expectedPlaceRevision + 1,
  };
}
type Call = { path: string; body: Record<string, unknown>; signal: AbortSignal };
function fixture(handler?: (call: Call, fallback: () => unknown) => unknown) {
  let entry: KeepEntryRef = originalEntry;
  let revision = 0;
  let position = 0;
  let command = 100;
  const calls: Call[] = [];
  const writes: SetKeepPlace[] = [];
  const scope = createAccountScope({
    account: { ...account },
    baseUrl: 'https://keep.fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const call: Call = {
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
        signal: request.signal,
      };
      calls.push(call);
      const fallback = () => {
        if (call.path.endsWith('/read')) {
          const readTarget = call.body.target as KeepAssetRef;
          return snapshot({ ...entry, ...readTarget }, revision, position);
        }
        const body = call.body as unknown as SetKeepPlace;
        writes.push(body);
        revision = body.expectedPlaceRevision + 1;
        if (body.position.kind === 'reel') position = body.position.positionMs;
        return acceptance(body);
      };
      const value = handler ? await handler(call, fallback) : fallback();
      return value instanceof Response ? value : Response.json(value);
    },
  });
  scopes.push(scope);
  const session = createKeepPlaceSession({ scope, newCommandId: () => id(command++) });
  return {
    scope,
    session,
    calls,
    writes,
    replace: (next: KeepEntryRef, rev = 0, pos = 0) => {
      entry = next;
      revision = rev;
      position = pos;
    },
  };
}
async function ready(handle: KeepPlaceHandle) {
  await vi.waitFor(() => expect(handle.getState().status).toBe('ready'));
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.end();
});

describe('scope-owned Keep foundation (authored protocol fixtures only)', () => {
  it('requires onEnd, isolates two actual scope objects with identical IDs, and synchronously purges before abort', async () => {
    const a = fixture();
    const b = fixture();
    expect(a.scope.id).toBe(b.scope.id);
    expect(createKeepPlaceSession({ scope: a.scope, newCommandId: () => id(999) })).toBe(a.session);
    expect(() =>
      createKeepPlaceSession({ scope: { ...a.scope, onEnd: undefined }, newCommandId: () => id(100) }),
    ).toThrow();
    const first = a.session.retain(target)!;
    const second = b.session.retain(target)!;
    await ready(first);
    await ready(second);
    const listener = vi.fn(() => expect(first.getState()).toEqual({ status: 'ended', write: 'idle' }));
    first.subscribe(listener);
    a.scope.end();
    expect(listener).toHaveBeenCalledOnce();
    expect(first.getState().snapshot).toBeUndefined();
    expect(a.scope.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(a.session.retain(target)).toBeUndefined();
    expect(first.setPosition({ kind: 'reel', positionMs: 4 })).toBe(false);
    expect(second.getState().status).toBe('ready');
    expect(b.scope.active).toBe(true);
  });

  it('drops an abort-ignoring read after epoch end and removes released details without persistence', async () => {
    const gate = deferred<unknown>();
    const f = fixture(() => gate.promise);
    const h = f.session.retain(target)!;
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.scope.end();
    gate.resolve(snapshot());
    await vi.waitFor(() => expect(f.calls[0]!.signal.aborted).toBe(true));
    expect(h.getState()).toEqual({ status: 'ended', write: 'idle' });
    expect(f.scope.storage.get('keep-place')).toBeUndefined();
    const other = fixture();
    const selected = other.session.retain(target)!;
    await ready(selected);
    selected.release();
    expect(selected.getState().snapshot).toBeUndefined();
    expect(other.scope.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('bounds retained entries and four underlying reads even when abort is ignored', async () => {
    const gates: ReturnType<typeof deferred<unknown>>[] = [];
    let active = 0;
    let maximum = 0;
    const f = fixture(async (call) => {
      active++;
      maximum = Math.max(maximum, active);
      const gate = deferred<unknown>();
      gates.push(gate);
      const value = await gate.promise;
      active--;
      return value ?? snapshot({ ...originalEntry, ...(call.body.target as KeepAssetRef) });
    });
    const handles = Array.from({ length: KEEP_PLACE_LIMITS.entries }, (_, i) =>
      f.session.retain({ assetId: id(1000 + i), assetRevision: 1 })!,
    );
    await vi.waitFor(() => expect(f.calls).toHaveLength(4));
    expect(f.session.retain({ assetId: id(9999), assetRevision: 1 })).toBeUndefined();
    for (const handle of handles) handle.release();
    expect(active).toBe(4);
    for (const gate of gates) gate.resolve(undefined);
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maximum).toBe(4);
    expect(f.calls).toHaveLength(4);
    const replacement = f.session.retain(target)!;
    await vi.waitFor(() => expect(f.calls).toHaveLength(5));
    gates[4]!.resolve(snapshot());
    await ready(replacement);
    expect(maximum).toBe(4);
  });

  it('retains exact command after lost ACK, explicitly replays it, rereads, then sends only the newest unsent position', async () => {
    let write = 0;
    const requests: SetKeepPlace[] = [];
    const f = fixture((call, fallback) => {
      if (call.path.endsWith('/read')) return fallback();
      const body = call.body as unknown as SetKeepPlace;
      requests.push(body);
      write++;
      if (write === 1) {
        fallback();
        throw new TypeError('offline fixture');
      }
      if (write === 2) return acceptance(body, true);
      return fallback();
    });
    const h = f.session.retain(target)!;
    await ready(h);
    expect(h.setPosition({ kind: 'reel', positionMs: 1.25 })).toBe(true);
    await vi.waitFor(() => expect(h.getState().write).toBe('unknown'));
    h.setPosition({ kind: 'reel', positionMs: 2 });
    h.setPosition({ kind: 'reel', positionMs: 3.75 });
    expect(requests).toHaveLength(1);
    expect(h.retry()).toBe(true);
    expect(h.retry()).toBe(false);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]!.commandId).not.toBe(requests[0]!.commandId);
    expect(requests[2]!.expectedPlaceRevision).toBe(1);
    expect(requests[2]!.position).toEqual({ kind: 'reel', positionMs: 3.75 });
    await vi.waitFor(() => expect(h.getState().write).toBe('idle'));
    expect(h.getState().snapshot).toMatchObject({ place: { placeRevision: 2, position: { positionMs: 3.75 } } });
    expect(f.calls.filter((x) => x.path.endsWith('/read')).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a released unknown command but fences its old dispatch while an explicit replay is in flight', async () => {
    const first = deferred<unknown>();
    const replay = deferred<unknown>();
    const requests: SetKeepPlace[] = [];
    const f = fixture((call, fallback) => {
      if (call.path.endsWith('/read')) return fallback();
      requests.push(call.body as unknown as SetKeepPlace);
      return requests.length === 1 ? first.promise : replay.promise;
    });
    const old = f.session.retain(target)!;
    await ready(old);
    old.setPosition({ kind: 'reel', positionMs: 2 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    old.release();
    const current = f.session.retain(target)!;
    await ready(current);
    expect(current.getState().write).toBe('unknown');
    expect(current.retry()).toBe(true);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual(requests[0]);
    first.resolve({ invalid: 'late fixture' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // The original dispatch cannot turn the newer replay back into retryable unknown.
    await vi.waitFor(() => expect(f.calls[1]!.signal.aborted).toBe(true));
    expect(current.getState().write).toBe('sending');
    expect(current.retry()).toBe(false);
    f.replace(originalEntry, 1, 2);
    replay.resolve(acceptance(requests[1]!, true));
    await vi.waitFor(() => expect(current.getState().snapshot).toMatchObject({ place: { placeRevision: 1 } }));
    expect(requests).toHaveLength(2);
  });

  it('never treats an acceptance as current position or allows a pre-ACK read to undo its required reread', async () => {
    const gate = deferred<unknown>();
    let reads = 0;
    const f = fixture((call, fallback) => (call.path.endsWith('/read') && ++reads === 2 ? gate.promise : fallback()));
    const h = f.session.retain(target)!;
    await ready(h);
    h.refresh();
    await vi.waitFor(() => expect(reads).toBe(2));
    h.setPosition({ kind: 'reel', positionMs: 5 });
    await vi.waitFor(() => expect(h.getState().write).toBe('refreshing'));
    expect(h.getState().snapshot).toMatchObject({ place: { status: 'none', placeRevision: 0 } });
    gate.resolve(snapshot());
    await vi.waitFor(() =>
      expect(h.getState().snapshot).toMatchObject({ place: { placeRevision: 1, position: { positionMs: 5 } } }),
    );
    expect(reads).toBe(3);
  });

  it('surfaces authorized stale CAS and requires explicit current-server or candidate choice', async () => {
    let conflict = true;
    const f = fixture((call, fallback) => {
      if (call.path.endsWith('/place') && conflict) {
        conflict = false;
        f.replace(originalEntry, 2, 9);
        return Response.json(
          { ...problemDetails('KEEP_PLACE_REVISION_STALE'), currentPlaceRevision: 2 },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return fallback();
    });
    const h = f.session.retain(target)!;
    await ready(h);
    h.setPosition({ kind: 'reel', positionMs: 4 });
    await vi.waitFor(() =>
      expect(h.getState()).toMatchObject({
        write: 'conflict',
        currentPlaceRevision: 2,
        snapshot: { place: { placeRevision: 2 } },
      }),
    );
    expect(f.calls.filter((x) => x.path.endsWith('/place'))).toHaveLength(1);
    expect(h.resolveConflict('candidate')).toBe(true);
    await vi.waitFor(() =>
      expect(h.getState().snapshot).toMatchObject({ place: { placeRevision: 3, position: { positionMs: 4 } } }),
    );
    expect(f.writes[0]!.expectedPlaceRevision).toBe(2);
    f.replace(originalEntry, 4, 10);
    h.refresh();
    await vi.waitFor(() => expect(h.getState().snapshot).toMatchObject({ place: { placeRevision: 4 } }));
  });

  it('uses existing scope invalidation without polling and permits an explicit server conflict choice', async () => {
    let stale = true;
    const f = fixture((call, fallback) => {
      if (call.path.endsWith('/place') && stale) {
        stale = false;
        f.replace(originalEntry, 1, 12);
        return Response.json(
          { ...problemDetails('KEEP_PLACE_REVISION_STALE'), currentPlaceRevision: 1 },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }
      return fallback();
    });
    const h = f.session.retain(target)!;
    await ready(h);
    h.setPosition({ kind: 'reel', positionMs: 3 });
    await vi.waitFor(() =>
      expect(h.getState()).toMatchObject({ write: 'conflict', snapshot: { place: { placeRevision: 1 } } }),
    );
    expect(h.resolveConflict('server')).toBe(true);
    expect(h.getState()).toMatchObject({ write: 'idle', snapshot: { place: { position: { positionMs: 12 } } } });
    expect(f.calls.filter((x) => x.path.endsWith('/place'))).toHaveLength(1);
    f.replace(originalEntry, 2, 14);
    await f.scope.queryClient.invalidateQueries({ queryKey: f.scope.queryKey() });
    await vi.waitFor(() =>
      expect(h.getState().snapshot).toMatchObject({ place: { placeRevision: 2, position: { positionMs: 14 } } }),
    );
    expect(f.calls.filter((x) => x.path.endsWith('/place'))).toHaveLength(1);
  });

  it('drops a former membership flight and unsent candidate across an ABA resave; late write cannot restore them', async () => {
    const gate = deferred<unknown>();
    let body: SetKeepPlace | undefined;
    const f = fixture((call, fallback) => {
      if (call.path.endsWith('/place')) {
        body = call.body as unknown as SetKeepPlace;
        return gate.promise;
      }
      return fallback();
    });
    const h = f.session.retain(target)!;
    await ready(h);
    h.setPosition({ kind: 'reel', positionMs: 7 });
    await vi.waitFor(() => expect(body).toBeDefined());
    h.setPosition({ kind: 'reel', positionMs: 8 });
    const next = { ...originalEntry, savedEntryId: id(8) };
    f.replace(next);
    h.refresh();
    await vi.waitFor(() => expect(h.getState().snapshot).toMatchObject({ entry: next, place: { placeRevision: 0 } }));
    gate.resolve(acceptance(body!));
    await vi.waitFor(() => expect(h.getState().write).toBe('idle'));
    expect(h.retry()).toBe(false);
    expect(f.calls.filter((x) => x.path.endsWith('/place'))).toHaveLength(1);
    expect(h.getState().snapshot).toMatchObject({ entry: next, place: { status: 'none' } });
  });

  it('purges all entries on authority refusal and fences an abort-ignoring write', async () => {
    const gate = deferred<unknown>();
    let writing: SetKeepPlace | undefined;
    let refuse = false;
    const f = fixture((call, fallback) => {
      if (refuse)
        return Response.json(problemDetails('FORBIDDEN'), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      if (call.path.endsWith('/place')) {
        writing = call.body as unknown as SetKeepPlace;
        return gate.promise;
      }
      return fallback();
    });
    const h = f.session.retain(target)!;
    await ready(h);
    h.setPosition({ kind: 'reel', positionMs: 6 });
    await vi.waitFor(() => expect(writing).toBeDefined());
    refuse = true;
    h.refresh();
    await vi.waitFor(() => expect(h.getState().status).toBe('ended'));
    gate.resolve(acceptance(writing!));
    expect(f.session.retain(target)).toBeUndefined();
    expect(h.retry()).toBe(false);
    expect(f.scope.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('clears a foreign scope reply and rejects malformed snapshots without publishing them', async () => {
    const invalid = fixture(() => ({ ...snapshot(), extra: 'fixture' }));
    const h = invalid.session.retain(target)!;
    await vi.waitFor(() => expect(h.getState()).toMatchObject({ status: 'unavailable', reason: 'invalid' }));
    expect(h.getState().snapshot).toBeUndefined();
    const foreign = fixture(() => ({ ...snapshot(), scope: { accountId: id(99), privacyEpoch: 1 } }));
    const other = foreign.session.retain(target)!;
    await vi.waitFor(() => expect(other.getState().status).toBe('ended'));
    expect(foreign.session.retain(target)).toBeUndefined();
  });
});
