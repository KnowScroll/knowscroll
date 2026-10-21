import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  problemDetails,
  type GeographyObject,
  type GeographyRoute,
  type GeographyAlias,
  type GeographyRevisions,
  type ReadSceneManifest,
  type SceneChunk,
  type SceneClientCapabilities,
  type SceneDescriptor,
  type UniverseDelta,
} from '@knowscroll/contracts';
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';
import { createUniverseSceneSession, UNIVERSE_SCENE_LIMITS, type UniverseSceneSession } from './universe-scene';

/** Authored protocol fixtures only. No app preview, backend, provider or established personal world. */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'scene@fixture.test' };
const recordedAt = '2026-10-21T00:00:00.000Z';
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
function place(
  n: number,
  kind: GeographyObject['kind'],
  parent = kind === 'system' ? account.universeId : id(10),
): GeographyObject {
  const fields = {
    id: id(n),
    objectRevision: 1,
    label: `Fixture ${n}`,
    truthStatus: 'factual' as const,
    activity: { availability: 'available' as const, state: 'active' as const },
    originTransitionId: id(90),
  };
  if (kind === 'system') return { ...fields, kind, parent: { kind: 'universe', id: parent } };
  if (kind === 'region') return { ...fields, kind, parent: { kind: 'planet', id: parent } };
  return { ...fields, kind, parent: { kind: 'system', id: parent } };
}
function descriptor(o: GeographyObject, n: number): SceneDescriptor {
  return {
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId: o.id,
    parentId: o.parent.id,
    kind: o.kind,
    originTransitionId: o.originTransitionId,
    label: o.label,
    truthStatus: o.truthStatus,
    activity: o.activity,
    family: 'terraced.v1',
    seed: 'a'.repeat(32),
    palette: 'cobalt',
    material: 'solid',
    atmosphere: { density: 0.1 },
    detail: { roughness: 0.2 },
    anchor: { x: n * 2, y: 0, layer: 0 },
    target: { kind: o.kind, objectId: o.id },
  };
}
function world() {
  return {
    geography: { revision: 3, structureRevision: 3, activityRevision: 0 },
    personalWatermark: 40,
    sceneRevision: 7,
    scenePersonalRevision: 35,
    objects: [
      place(10, 'system'),
      place(11, 'star'),
      place(12, 'planet'),
      place(13, 'planet'),
      place(14, 'region', id(12)),
    ],
    routes: [
      {
        id: id(80),
        kind: 'route' as const,
        relationRevision: 2,
        originTransitionId: id(90),
        status: 'current' as const,
        fromObjectId: id(12),
        toObjectId: id(13),
        truthStatus: 'factual' as const,
      },
    ] as GeographyRoute[],
    aliases: [] as GeographyAlias[],
  };
}
type World = ReturnType<typeof world>;
type Query = ReadSceneManifest;
function chunks(w: World): SceneChunk[] {
  // Deliberately split parents and a route's endpoints across immutable chunks.
  const descriptors = w.objects.map(descriptor);
  const result: SceneChunk[] = [];
  for (let start = 0; start < descriptors.length; start += 2)
    result.push({
      schemaVersion: 'scene-chunk.v1',
      chunkId: id(10000 + start),
      revisions: {
        geographyRevision: w.geography.revision,
        structureRevision: w.geography.structureRevision,
        activityRevision: w.geography.activityRevision,
        sceneRevision: w.sceneRevision - 1,
        personalRevision: w.scenePersonalRevision,
      },
      objects: descriptors.slice(start, start + 2),
      routes:
        start === 0
          ? w.routes
              .filter((r) => r.status === 'current')
              .map(({ id: routeId, fromObjectId, toObjectId, originTransitionId, truthStatus }) => ({
                id: routeId,
                fromObjectId,
                toObjectId,
                originTransitionId,
                truthStatus,
              }))
          : [],
    });
  return result;
}
function fields(w: World, query: Query, scopeAccount = account) {
  return {
    ...query,
    scope: {
      universeId: scopeAccount.universeId,
      privacyEpoch: scopeAccount.privacyEpoch,
      personalWatermark: w.personalWatermark,
    },
    recordedAt,
    currentGeography: w.geography,
    sceneRevision: w.sceneRevision,
  };
}
function manifest(w: World, query: Query) {
  return {
    version: 'scene-manifest-read.v1',
    ...fields(w, query),
    status: w.objects.length ? 'ready' : 'empty',
    manifest: {
      schemaVersion: 'scene-manifest.v1',
      revisions: {
        geographyRevision: w.geography.revision,
        structureRevision: w.geography.structureRevision,
        activityRevision: w.geography.activityRevision,
        sceneRevision: w.sceneRevision,
        personalRevision: w.scenePersonalRevision,
      },
      chunks: chunks(w).map((c) => ({
        chunkId: c.chunkId,
        sceneRevision: c.revisions.sceneRevision,
        objectIds: c.objects.map((o) => o.objectId),
      })),
    },
  };
}
function geoPage(w: World, after = '', limit = 100) {
  const remaining = w.objects.filter((o) => o.id > after),
    objects = remaining.slice(0, limit);
  return {
    version: 'geography-snapshot.v1',
    universeId: account.universeId,
    privacyEpoch: account.privacyEpoch,
    personalWatermark: w.personalWatermark,
    recordedAt,
    geography: w.geography,
    selection: { kind: 'universe' },
    status: objects.length ? 'ready' : 'empty',
    ...(objects.length
      ? {
          page: {
            objects,
            routes: w.routes,
            aliases: w.aliases,
            continuation:
              remaining.length > objects.length
                ? {
                    status: 'more',
                    cursor: {
                      universeId: account.universeId,
                      privacyEpoch: 1,
                      geographyRevision: w.geography.revision,
                      selection: { kind: 'universe' },
                      afterObjectId: objects.at(-1)!.id,
                    },
                  }
                : { status: 'complete' },
          },
        }
      : {}),
  };
}
interface Call {
  path: string;
  body: Record<string, unknown>;
  request: Request;
}
type Handler = (call: Call, fallback: () => unknown) => unknown;
const scopes: AccountScope[] = [],
  sessions: UniverseSceneSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const s of scopes.splice(0)) s.end();
});
function harness(w = world(), handler?: Handler, scopeAccount = account) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const call = {
      path: new URL(request.url).pathname,
      body: (await request.json()) as Record<string, unknown>,
      request,
    };
    calls.push(call);
    const fallback = () => {
      if (call.path.endsWith('/geography/read')) {
        const cursor = call.body.cursor as { afterObjectId: string } | undefined;
        return geoPage(w, cursor?.afterObjectId, call.body.limit as number);
      }
      if (call.path.endsWith('/geography/deltas/read'))
        return {
          version: 'universe-deltas.v1',
          status: 'available',
          universeId: account.universeId,
          privacyEpoch: 1,
          personalWatermark: w.personalWatermark,
          afterGeographyRevision: call.body.afterGeographyRevision,
          geography: w.geography,
          deltas: [],
          hasMore: false,
        };
      const query = call.body as Query;
      if (call.path.endsWith('/scenes/manifest/read')) return manifest(w, query);
      const reference = call.body.reference as { chunkId: string };
      return {
        version: 'scene-chunk-read.v1',
        ...fields(w, query),
        reference: call.body.reference,
        status: 'ready',
        chunk: chunks(w).find((c) => c.chunkId === reference.chunkId),
      };
    };
    const reply = handler ? await handler(call, fallback) : fallback();
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const scope = createAccountScope({
    account: scopeAccount,
    baseUrl: 'https://scene.fixture.test',
    fetch,
    authorization: () => undefined,
    store: memoryStore(),
  });
  scopes.push(scope);
  const make = (caps = capabilities, given = scope) => {
    const session = createUniverseSceneSession({ scope: given, capabilities: caps });
    sessions.push(session);
    return session;
  };
  return { w, calls, fetch, scope, make };
}
async function settled(session: UniverseSceneSession, status = 'ready') {
  await vi.waitFor(() => expect(session.getState().status).toBe(status), { timeout: 5000 });
  return session.getState();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('scope-owned readonly Universe session (authored CI fixtures)', () => {
  it('assembles exact cross-chunk parents/routes with older unchanged chunk versions and independent revisions', async () => {
    const h = harness(),
      session = h.make();
    expect(h.calls).toHaveLength(0);
    session.start();
    const state = await settled(session);
    expect(state.geography?.objects).toHaveLength(5);
    expect(state.snapshot?.chunks.flatMap((c) => c.objects)).toHaveLength(5);
    expect(state.snapshot?.read.sceneRevision).toBe(7);
    expect(state.snapshot?.read.manifest.revisions.personalRevision).toBe(35);
    expect(state.snapshot?.chunks.every((c) => c.revisions.sceneRevision === 6)).toBe(true);
    expect(
      h.calls.every((c) => c.request.method === 'POST' && c.request.headers.get('x-ks-scope') === h.scope.id),
    ).toBe(true);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/v1/universe/geography/read',
      '/v1/universe/scenes/manifest/read',
      '/v1/universe/scenes/chunks/read',
      '/v1/universe/scenes/chunks/read',
      '/v1/universe/scenes/chunks/read',
    ]);
    expect(
      h.scope.queryClient
        .getQueryCache()
        .getAll()
        .every((q) => typeof q.state.data === 'number'),
    ).toBe(true);
    expect(() => {
      state.snapshot!.chunks[0]!.objects[0]!.label = 'mutated';
    }).toThrow();
  });
  it('keeps authoritative empty distinct from network loading and real pending projection', async () => {
    const w = world();
    w.objects = [];
    w.routes = [];
    w.geography = { revision: 0, structureRevision: 0, activityRevision: 0 };
    w.sceneRevision = 0;
    const h = harness(w),
      s = h.make();
    s.start();
    expect(s.getState().status).toBe('loading');
    const state = await settled(s, 'empty');
    expect(state.snapshot?.chunks).toEqual([]);
    expect(state.pendingProjection).toBeUndefined();
    expect(h.calls.filter((c) => c.path.endsWith('/chunks/read'))).toHaveLength(0);
  });
  it.each(['loading', 'lagging', 'unavailable', 'unsupported_version'] as const)(
    'preserves the actual %s branch',
    async (status) => {
      const caps = status === 'unsupported_version' ? { ...capabilities, generators: ['silhouette.v2'] } : capabilities;
      const h = harness(world(), (call, fallback) => {
        if (!call.path.endsWith('/manifest/read')) {
          const value = fallback();
          if (status === 'lagging' && call.path.endsWith('/chunks/read')) {
            const reply = value as { chunk: SceneChunk };
            return {
              ...reply,
              chunk: {
                ...reply.chunk,
                revisions: { ...reply.chunk.revisions, geographyRevision: 2, structureRevision: 2 },
              },
            };
          }
          return value;
        }
        const query = call.body as Query,
          value = manifest(h.w, query);
        if (status === 'lagging')
          return {
            ...value,
            status,
            manifest: {
              ...value.manifest,
              revisions: { ...value.manifest.revisions, geographyRevision: 2, structureRevision: 2 },
            },
            pendingProjection: { geographyRevision: 3, personalRevision: 40 },
          };
        return {
          version: value.version,
          ...fields(h.w, query),
          status,
          ...(status === 'loading' ? { pendingProjection: { geographyRevision: 3, personalRevision: 40 } } : {}),
          ...(status === 'unavailable' ? { reason: 'temporarily_unavailable' } : {}),
        };
      });
      const s = h.make(caps);
      s.start();
      if (status === 'loading')
        await vi.waitFor(() =>
          expect(s.getState().pendingProjection).toEqual({ geographyRevision: 3, personalRevision: 40 }),
        );
      const state = await settled(s, status === 'unsupported_version' ? 'unsupported' : status);
      expect(state.pendingProjection !== undefined).toBe(status === 'loading' || status === 'lagging');
      expect(state.snapshot !== undefined).toBe(status === 'lagging');
    },
  );
  it('refuses malformed pending, unadvertised capability echoes and operational descriptor fields', async () => {
    for (const patch of ['pending', 'capabilities', 'descriptor']) {
      const h = harness(world(), (c, fallback) => {
        const value = fallback();
        if (c.path.endsWith('/manifest/read') && patch === 'pending')
          return { version: 'scene-manifest-read.v1', ...fields(h.w, c.body as Query), status: 'loading' };
        if (c.path.endsWith('/manifest/read') && patch === 'capabilities')
          return { ...manifest(h.w, c.body as Query), capabilities: { ...capabilities, detail: 'low' } };
        if (c.path.endsWith('/chunks/read') && patch === 'descriptor') {
          const reply = value as { chunk: SceneChunk };
          return {
            ...reply,
            chunk: { ...reply.chunk, objects: reply.chunk.objects.map((o) => ({ ...o, source: 'private-canary' })) },
          };
        }
        return value;
      });
      const s = h.make();
      s.start();
      expect((await settled(s, 'unavailable')).reason).toBe('invalid');
      expect(JSON.stringify(s.getState())).not.toContain('private-canary');
    }
  });
  it('deduplicates repeated identical routes and aliases across stable pages', async () => {
    const w = world();
    w.aliases = [
      {
        id: id(81),
        kind: 'alias',
        relationRevision: 2,
        originTransitionId: id(90),
        status: 'current',
        fromObjectId: id(12),
        toObjectId: id(13),
      },
    ];
    const h = harness(w, (c, fallback) =>
      c.path.endsWith('/geography/read')
        ? geoPage(w, (c.body.cursor as { afterObjectId: string } | undefined)?.afterObjectId, 2)
        : fallback(),
    );
    const s = h.make();
    s.start();
    const state = await settled(s);
    expect(state.geography?.routes).toHaveLength(1);
    expect(state.geography?.aliases).toHaveLength(1);
    expect(h.calls.filter((c) => c.path.endsWith('/geography/read'))).toHaveLength(3);
  });
  it.each(['revision', 'cursor', 'relation', 'order'])(
    'refuses mixed/looping %s pages with bounded recovery and no partial display',
    async (kind) => {
      const h = harness(world(), (c, fallback) => {
        if (!c.path.endsWith('/geography/read')) return fallback();
        const after = (c.body.cursor as { afterObjectId: string } | undefined)?.afterObjectId;
        const page = geoPage(h.w, after, 2);
        if (!after || !('page' in page)) return page;
        if (kind === 'revision')
          return { ...page, geography: { revision: 4, structureRevision: 4, activityRevision: 0 } };
        if (kind === 'cursor')
          return { ...page, page: { ...page.page, continuation: { status: 'more', cursor: c.body.cursor } } };
        if (kind === 'relation')
          return { ...page, page: { ...page.page, routes: h.w.routes.map((r) => ({ ...r, status: 'withdrawn' })) } };
        return geoPage(h.w, '', 2);
      });
      const s = h.make();
      s.start();
      const state = await settled(s, 'unavailable');
      expect(state.snapshot).toBeUndefined();
      expect(state.geography).toBeUndefined();
      expect(h.calls.length).toBeLessThanOrEqual(4);
    },
  );
  it('recovers an expired cursor with one fresh snapshot', async () => {
    let expired = false;
    const h = harness(world(), (c, fallback) => {
      if (!c.path.endsWith('/geography/read')) return fallback();
      if (c.body.cursor && !expired) {
        expired = true;
        return { ...geoPage(h.w), page: undefined, status: 'unavailable', reason: 'snapshot_expired' };
      }
      return geoPage(h.w, (c.body.cursor as { afterObjectId: string } | undefined)?.afterObjectId, expired ? 100 : 2);
    });
    const s = h.make();
    s.start();
    await settled(s);
    expect(h.calls.filter((c) => c.path.endsWith('/geography/read'))).toHaveLength(3);
  });
  it('retains last valid data on network failure, but clears it on authoritative refusal without echoing private errors', async () => {
    let mode = 'ready';
    const h = harness(world(), (_c, fallback) => {
      if (mode === 'network') throw new TypeError('private-network-canary');
      if (mode === 'authority')
        return new Response(JSON.stringify(problemDetails('UNIVERSE_UNAVAILABLE')), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      return fallback();
    });
    const s = h.make();
    s.start();
    const before = (await settled(s)).snapshot;
    mode = 'network';
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'unavailable', reason: 'network', snapshot: before });
    expect(JSON.stringify(s.getState())).not.toContain('private-network-canary');
    mode = 'authority';
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'unavailable', reason: 'authority' });
    expect(s.getState().snapshot).toBeUndefined();
    expect(s.getState().geography).toBeUndefined();
  });
  it('uses existing query invalidation, pauses without polling, and resumes through catch-up', async () => {
    const h = harness(),
      s = h.make();
    s.start();
    await settled(s);
    const count = h.calls.length;
    await h.scope.queryClient.invalidateQueries({ queryKey: h.scope.queryKey() });
    expect(h.calls.length).toBeGreaterThan(count);
    expect(h.calls.some((c) => c.path.endsWith('/deltas/read'))).toBe(true);
    s.pause();
    const paused = h.calls.length;
    await h.scope.queryClient.invalidateQueries({ queryKey: h.scope.queryKey() });
    expect(h.calls).toHaveLength(paused);
    expect(s.getState().active).toBe(false);
    s.resume();
    await settled(s);
    expect(h.calls.length).toBeGreaterThan(paused);
    expect(h.calls.every((c) => /\/(geography|scenes)\/(?:deltas\/|manifest\/|chunks\/)?read$/.test(c.path))).toBe(
      true,
    );
  });
  it('requires a real synchronous end capability before any request or subscription', async () => {
    const h = harness();
    const withoutEnd = { ...h.scope, onEnd: undefined };
    const s = h.make(capabilities, withoutEnd);
    s.start();
    await s.refresh();
    expect(s.getState()).toEqual({ status: 'unavailable', active: false, reason: 'scope_unavailable' });
    expect(h.calls).toEqual([]);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
  });
  it('synchronously purges listeners, cache, selection and data, fencing late abort-ignoring replies', async () => {
    const wait = deferred<unknown>();
    let delay = false;
    const h = harness(world(), (c, fallback) =>
      delay && c.path.endsWith('/manifest/read') ? wait.promise : fallback(),
    );
    const s = h.make();
    s.start();
    await settled(s);
    const listener = vi.fn();
    s.subscribe(listener);
    delay = true;
    const pending = s.refresh();
    await vi.waitFor(() => expect(h.calls.filter((c) => c.path.endsWith('/manifest/read'))).toHaveLength(2));
    h.scope.end();
    expect(s.getState()).toEqual({ status: 'ended', active: false });
    const notices = listener.mock.calls.length;
    wait.resolve(manifest(h.w, { selection: { kind: 'universe' }, capabilities }));
    await pending;
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(notices);
    expect(s.getState()).toEqual({ status: 'ended', active: false });
    const count = h.calls.length;
    s.start();
    s.resume();
    s.select({ kind: 'system', systemId: id(10) });
    await s.refresh();
    expect(h.calls).toHaveLength(count);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
  });
  it('isolates two scope objects with the same account and epoch, and refuses another epoch response', async () => {
    const old = harness(),
      next = harness();
    const a = old.make(),
      b = next.make();
    a.start();
    b.start();
    await settled(a);
    await settled(b);
    old.scope.end();
    expect(a.getState().status).toBe('ended');
    expect(b.getState().status).toBe('ready');
    const wrong = harness(world(), (c, fallback) =>
      c.path.endsWith('/geography/read') ? { ...geoPage(world()), privacyEpoch: 2 } : fallback(),
    );
    const s = wrong.make();
    s.start();
    expect((await settled(s, 'unavailable')).reason).toBe('authority');
  });
  it('refuses a foreign universe even if the account or epoch text otherwise matches', async () => {
    const h = harness(world(), undefined, { ...account, accountId: id(200), universeId: id(201) });
    const s = h.make();
    s.start();
    expect((await settled(s, 'unavailable')).reason).toBe('authority');
  });
  it('supersedes an abort-ignoring old selection without reusing its completed scene', async () => {
    const wait = deferred<unknown>();
    let delayed = false;
    const h = harness(world(), (c, fallback) => {
      if (c.path.endsWith('/manifest/read') && (c.body.selection as { kind: string }).kind === 'universe' && !delayed) {
        delayed = true;
        return wait.promise;
      }
      return fallback();
    });
    const s = h.make();
    s.start();
    await vi.waitFor(() => expect(delayed).toBe(true));
    s.select({ kind: 'system', systemId: id(10) });
    await settled(s);
    wait.resolve(manifest(h.w, { selection: { kind: 'universe' }, capabilities }));
    await Promise.resolve();
    expect(s.getState().snapshot?.read.selection).toEqual({ kind: 'system', systemId: id(10) });
  });
  it.each(['foreign', 'reference', 'selection', 'objects', 'parent', 'route', 'unknown'])(
    'refuses %s chunks without partial publication',
    async (kind) => {
      const h = harness(world(), (c, fallback) => {
        const value = fallback();
        if (!c.path.endsWith('/chunks/read')) return value;
        const reply = value as {
          chunk: SceneChunk;
          reference: Record<string, unknown>;
          scope: Record<string, unknown>;
        };
        if (kind === 'foreign') return { ...reply, scope: { ...reply.scope, privacyEpoch: 2 } };
        if (kind === 'reference') return { ...reply, reference: { ...reply.reference, chunkId: id(333) } };
        if (kind === 'selection') return { ...reply, selection: { kind: 'system', systemId: id(10) } };
        if (kind === 'unknown')
          return {
            version: 'scene-chunk-read.v1',
            ...fields(h.w, c.body as Query),
            reference: c.body.reference,
            status: 'unavailable',
            reason: 'unknown_chunk',
          };
        if (kind === 'objects') return { ...reply, chunk: { ...reply.chunk, objects: reply.chunk.objects.slice(1) } };
        if (kind === 'parent')
          return {
            ...reply,
            chunk: {
              ...reply.chunk,
              objects: reply.chunk.objects.map((o) => (o.kind === 'system' ? o : { ...o, parentId: id(555) })),
            },
          };
        return {
          ...reply,
          chunk: { ...reply.chunk, routes: reply.chunk.routes.map((r) => ({ ...r, toObjectId: id(555) })) },
        };
      });
      const s = h.make();
      s.start();
      expect((await settled(s, 'unavailable')).snapshot).toBeUndefined();
    },
  );
  it.each([1, 2])('rereads a stale manifest once, with %i stale round(s)', async (staleRounds) => {
    let manifests = 0;
    const h = harness(world(), (c, fallback) => {
      if (c.path.endsWith('/manifest/read')) manifests++;
      if (c.path.endsWith('/chunks/read') && manifests <= staleRounds)
        return {
          version: 'scene-chunk-read.v1',
          ...fields(h.w, c.body as Query),
          reference: c.body.reference,
          status: 'unavailable',
          reason: 'stale_manifest',
        };
      return fallback();
    });
    const s = h.make();
    s.start();
    await settled(s);
    // Two stale rounds exhaust the first read, then one bounded fresh-snapshot recovery succeeds.
    expect(manifests).toBe(staleRounds + 1);
    expect(manifests).toBeLessThanOrEqual(4);
  });
  it('stops perpetually stale manifests with bounded retries', async () => {
    const h = harness(world(), (c, fallback) =>
      c.path.endsWith('/chunks/read')
        ? {
            version: 'scene-chunk-read.v1',
            ...fields(h.w, c.body as Query),
            reference: c.body.reference,
            status: 'unavailable',
            reason: 'stale_manifest',
          }
        : fallback(),
    );
    const s = h.make();
    s.start();
    expect((await settled(s, 'unavailable')).reason).toBe('refresh_required');
    expect(h.calls.filter((c) => c.path.endsWith('/manifest/read'))).toHaveLength(4);
  });
  it('keeps no more than four chunk requests active and stops a failed generation', async () => {
    const w = world();
    w.objects.push(...Array.from({ length: 15 }, (_, i) => place(100 + i, 'planet')));
    let pending = 0,
      maximum = 0;
    const releases: (() => void)[] = [];
    const h = harness(w, async (c, fallback) => {
      if (!c.path.endsWith('/chunks/read')) return fallback();
      pending++;
      maximum = Math.max(maximum, pending);
      await new Promise<void>((resolve) => releases.push(resolve));
      pending--;
      return fallback();
    });
    const s = h.make();
    s.start();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(maximum).toBe(4);
    for (let wave = 0; wave < 3; wave++) {
      releases.splice(0).forEach((r) => r());
      await vi.waitFor(() => expect(s.getState().status === 'ready' || releases.length > 0).toBe(true));
    }
    await settled(s);
    expect(maximum).toBe(UNIVERSE_SCENE_LIMITS.concurrentChunks);
  });
  it('enforces global object and canonical document bounds without displaying a truncated map', async () => {
    for (const kind of ['objects', 'chunks', 'bytes']) {
      const w = world();
      if (kind === 'objects')
        w.objects = [place(10, 'system'), ...Array.from({ length: 1000 }, (_, i) => place(100 + i, 'planet'))];
      const h = harness(w, (c, fallback) => {
        if (kind === 'chunks' && c.path.endsWith('/manifest/read')) {
          const m = manifest(w, c.body as Query);
          return {
            ...m,
            manifest: {
              ...m.manifest,
              chunks: Array.from({ length: 129 }, (_, i) => ({
                chunkId: id(10000 + i),
                sceneRevision: 6,
                objectIds: [],
              })),
            },
          };
        }
        if (kind === 'bytes' && c.path.endsWith('/chunks/read')) {
          const reply = fallback() as { chunk: SceneChunk };
          return {
            ...reply,
            chunk: { ...reply.chunk, objects: reply.chunk.objects.map((o) => ({ ...o, label: 'x'.repeat(262145) })) },
          };
        }
        return fallback();
      });
      const s = h.make();
      s.start();
      const state = await settled(s, 'unavailable');
      expect(state.snapshot).toBeUndefined();
      expect(h.calls.length).toBeLessThanOrEqual(12);
    }
  });
  it('accepts the complete 1000-object bound and preserves all semantic identities', async () => {
    const w = world();
    w.routes = [];
    w.objects = [place(10, 'system'), ...Array.from({ length: 999 }, (_, i) => place(100 + i, 'planet'))];
    const h = harness(w, (c, fallback) => {
      if (c.path.endsWith('/manifest/read')) {
        const m = manifest(w, c.body as Query);
        return {
          ...m,
          manifest: {
            ...m.manifest,
            chunks: largeChunks.map((chunk) => ({
              chunkId: chunk.chunkId,
              sceneRevision: 6,
              objectIds: chunk.objects.map((o) => o.objectId),
            })),
          },
        };
      }
      if (c.path.endsWith('/chunks/read'))
        return {
          version: 'scene-chunk-read.v1',
          ...fields(w, c.body as Query),
          reference: c.body.reference,
          status: 'ready',
          chunk: largeChunks.find((v) => v.chunkId === (c.body.reference as { chunkId: string }).chunkId),
        };
      return fallback();
    });
    const largeChunks: SceneChunk[] = Array.from({ length: 10 }, (_, i) => ({
      schemaVersion: 'scene-chunk.v1',
      chunkId: id(10000 + i),
      revisions: {
        geographyRevision: 3,
        structureRevision: 3,
        activityRevision: 0,
        sceneRevision: 6,
        personalRevision: 35,
      },
      objects: w.objects.slice(i * 100, i * 100 + 100).map(descriptor),
      routes: [],
    }));
    const s = h.make();
    s.start();
    const state = await settled(s);
    expect(state.geography?.objects).toHaveLength(1000);
    expect(state.snapshot?.chunks.flatMap((c) => c.objects)).toHaveLength(1000);
    expect(h.calls.filter((c) => c.path.endsWith('/geography/read'))).toHaveLength(10);
  });
});

describe('atomic contiguous Geography catch-up (authored CI deltas)', () => {
  const delta = (
    base: GeographyRevisions,
    operations: UniverseDelta['operations'],
    serial = base.revision + 1,
  ): UniverseDelta => {
    const revision = base.revision + 1;
    return {
      version: 'universe-delta.v1',
      universeId: account.universeId,
      privacyEpoch: 1,
      personalWatermark: 40 + revision,
      transitionId: id(1000 + serial),
      recordedAt,
      base,
      geography: {
        revision,
        structureRevision: operations.some((o) => o.kind !== 'set_activity') ? revision : base.structureRevision,
        activityRevision: operations.some((o) => o.kind === 'set_activity') ? revision : base.activityRevision,
      },
      operations,
    };
  };
  it('applies all eight operation kinds, a complete batch once, without deriving Scene appearance', async () => {
    const w = world();
    w.objects = [];
    w.routes = [];
    w.geography = { revision: 0, structureRevision: 0, activityRevision: 0 };
    w.sceneRevision = 0;
    const applied: UniverseDelta[] = [];
    const h = harness(w, (c, fallback) =>
      c.path.endsWith('/deltas/read')
        ? {
            version: 'universe-deltas.v1',
            status: 'available',
            universeId: account.universeId,
            privacyEpoch: 1,
            personalWatermark: w.personalWatermark,
            afterGeographyRevision: c.body.afterGeographyRevision,
            geography: w.geography,
            deltas: applied.filter((d) => d.base.revision >= (c.body.afterGeographyRevision as number)),
            hasMore: false,
          }
        : fallback(),
    );
    const s = h.make();
    s.start();
    await settled(s, 'empty');
    const add = (operation: UniverseDelta['operations'][number]) => {
      const next = delta(w.geography, [operation]);
      applied.push(next);
      w.geography = next.geography;
      w.personalWatermark = next.personalWatermark;
    };
    for (const [n, kind, parent] of [
      [10, 'system', account.universeId],
      [11, 'star', id(10)],
      [12, 'planet', id(10)],
      [13, 'planet', id(10)],
      [14, 'region', id(12)],
    ] as const) {
      const o = {
        ...place(n, kind, parent),
        objectRevision: w.geography.revision + 1,
        originTransitionId: id(1000 + w.geography.revision + 1),
      };
      w.objects.push(o);
      const opKind = {
        system: 'create_system',
        star: 'establish_star',
        planet: 'form_planet',
        region: 'add_region',
      } as const;
      // Select concrete variants so this fixture remains checked by the actual public union.
      if (o.kind === 'system') add({ kind: opKind.system, object: o });
      else if (o.kind === 'star') add({ kind: opKind.star, object: o });
      else if (o.kind === 'planet') add({ kind: opKind.planet, object: o });
      else add({ kind: opKind.region, object: o });
    }
    const route: GeographyRoute = {
      id: id(80),
      kind: 'route',
      relationRevision: 6,
      originTransitionId: id(1006),
      status: 'current',
      fromObjectId: id(12),
      toObjectId: id(13),
      truthStatus: 'factual',
    };
    w.routes.push(route);
    add({ kind: 'connect_route', route });
    w.objects = w.objects.map((o) =>
      o.id === id(12) ? { ...o, objectRevision: 7, label: 'Changed fixture label' } : o,
    );
    add({ kind: 'revise_label', objectId: id(12), objectRevision: 7, label: 'Changed fixture label' });
    w.objects = w.objects.map((o) =>
      o.id === id(12) ? { ...o, objectRevision: 8, activity: { availability: 'available', state: 'quiet' } } : o,
    );
    add({
      kind: 'set_activity',
      objectId: id(12),
      objectRevision: 8,
      activity: { availability: 'available', state: 'quiet' },
    });
    w.routes = w.routes.map((r) => ({ ...r, status: 'withdrawn', relationRevision: 9 }));
    add({ kind: 'withdraw_relation', relationId: id(80), relationRevision: 9 });
    w.sceneRevision = 12;
    w.scenePersonalRevision = w.personalWatermark;
    await s.refresh();
    expect(s.getState().status).toBe('ready');
    expect(s.getState().geography?.geography).toEqual({ revision: 9, structureRevision: 9, activityRevision: 8 });
    expect(s.getState().geography?.objects).toEqual(w.objects);
    expect(s.getState().geography?.routes).toEqual(w.routes);
    expect(s.getState().snapshot?.chunks.flatMap((c) => c.routes)).toEqual([]);
    const appearance = s.getState().snapshot?.chunks.flatMap((c) => c.objects);
    expect(appearance?.map((o) => o.seed)).toEqual(w.objects.map(() => 'a'.repeat(32)));
    await s.refresh();
    expect(s.getState().geography?.objects).toHaveLength(5);
    expect(h.calls.filter((c) => c.path.endsWith('/geography/read'))).toHaveLength(1);
  });
  it.each(['gap', 'duplicate', 'unknown', 'base', 'atomic', 'scope', 'watermark'])(
    'rejects %s delta batch and recovers without partially applied effects',
    async (kind) => {
      let changed = false;
      const w = world(),
        d = delta(w.geography, [{ kind: 'revise_label', objectId: id(12), objectRevision: 4, label: 'MUST NOT LEAK' }]);
      const h = harness(w, (c, fallback) => {
        if (!changed || !c.path.endsWith('/deltas/read')) return fallback();
        const valid = {
          version: 'universe-deltas.v1',
          status: 'available',
          universeId: account.universeId,
          privacyEpoch: 1,
          personalWatermark: 44,
          afterGeographyRevision: 3,
          geography: d.geography,
          deltas: [d],
          hasMore: false,
        };
        if (kind === 'gap') return { ...valid, afterGeographyRevision: 2 };
        if (kind === 'duplicate') return { ...valid, deltas: [d, d] };
        if (kind === 'unknown')
          return { ...valid, deltas: [{ ...d, operations: [{ kind: 'invent_planet', value: 'private-canary' }] }] };
        if (kind === 'base') return { ...valid, deltas: [{ ...d, base: { ...d.base, activityRevision: 2 } }] };
        if (kind === 'scope') return { ...valid, universeId: id(400) };
        if (kind === 'watermark') return { ...valid, personalWatermark: 10 };
        return {
          ...valid,
          deltas: [
            {
              ...d,
              operations: [
                ...d.operations,
                {
                  kind: 'set_activity',
                  objectId: id(555),
                  objectRevision: 4,
                  activity: { availability: 'unavailable' },
                },
              ],
              geography: { ...d.geography, activityRevision: 4 },
            },
          ],
          geography: { ...d.geography, activityRevision: 4 },
        };
      });
      const s = h.make();
      s.start();
      await settled(s);
      changed = true;
      await s.refresh();
      if (kind === 'scope') {
        expect(s.getState().reason).toBe('authority');
        expect(s.getState().geography).toBeUndefined();
      } else {
        expect(s.getState().status).toBe('ready');
        expect(s.getState().geography?.geography.revision).toBe(3);
        expect(h.calls.filter((c) => c.path.endsWith('/geography/read'))).toHaveLength(2);
      }
      expect(JSON.stringify(s.getState())).not.toContain('MUST NOT LEAK');
      expect(JSON.stringify(s.getState())).not.toContain('private-canary');
    },
  );
  it('limits hasMore catch-up to four batches before a complete snapshot', async () => {
    let catching = false;
    const w = world();
    const h = harness(w, (c, fallback) => {
      if (!catching || !c.path.endsWith('/deltas/read')) return fallback();
      const after = c.body.afterGeographyRevision as number;
      const base = { revision: after, structureRevision: after, activityRevision: 0 };
      const d = delta(base, [
        { kind: 'revise_label', objectId: id(12), objectRevision: after + 1, label: 'Interim fixture' },
      ]);
      d.personalWatermark = 100;
      return {
        version: 'universe-deltas.v1',
        status: 'available',
        universeId: account.universeId,
        privacyEpoch: 1,
        personalWatermark: 100,
        afterGeographyRevision: after,
        geography: { revision: 10, structureRevision: 10, activityRevision: 0 },
        deltas: [d],
        hasMore: true,
      };
    });
    const s = h.make();
    s.start();
    await settled(s);
    catching = true;
    // Each later delta must follow the root watermark of the preceding response.
    w.personalWatermark = 100;
    await s.refresh();
    expect(s.getState().status).toBe('ready');
    expect(h.calls.filter((c) => c.path.endsWith('/deltas/read')).length).toBe(4);
    expect(h.calls.filter((c) => c.path.endsWith('/geography/read'))).toHaveLength(2);
  });
  it('does not accept regressed Geography behind a newer personal root watermark', async () => {
    let regress = false;
    const h = harness(world(), (c, fallback) => {
      if (!regress) return fallback();
      if (c.path.endsWith('/deltas/read'))
        return {
          version: 'universe-deltas.v1',
          status: 'snapshot_required',
          universeId: account.universeId,
          privacyEpoch: 1,
          personalWatermark: 100,
          geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
        };
      if (c.path.endsWith('/geography/read'))
        return {
          ...geoPage(h.w),
          personalWatermark: 100,
          geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
        };
      return fallback();
    });
    const s = h.make();
    s.start();
    const before = (await settled(s)).snapshot;
    regress = true;
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'unavailable', reason: 'refresh_required', snapshot: before });
    expect(s.getState().geography?.geography.revision).toBe(3);
  });
});

it.each(['manifest', 'chunk'])(
  'clears an existing view on a foreign %s envelope even when reference refinements also fail',
  async (kind) => {
    let foreign = false;
    const h = harness(world(), (c, fallback) => {
      const value = fallback();
      if (foreign && c.path.endsWith(kind === 'manifest' ? '/manifest/read' : '/chunks/read')) {
        const reply = value as { scope: Record<string, unknown> };
        return { ...reply, scope: { ...reply.scope, privacyEpoch: 2 } };
      }
      return value;
    });
    const s = h.make();
    s.start();
    await settled(s);
    foreign = true;
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'unavailable', reason: 'authority' });
    expect(s.getState().snapshot).toBeUndefined();
    expect(s.getState().geography).toBeUndefined();
  },
);
