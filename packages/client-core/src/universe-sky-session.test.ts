import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  problemDetails,
  SCENE_SKY_VERSION,
  type GeographyObject,
  type SceneChunk,
  type SceneClientCapabilities,
  type SceneDescriptor,
  type SceneLook,
} from '@knowscroll/contracts';
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';
import { createUniverseSceneSession, UNIVERSE_SCENE_LIMITS, type UniverseSceneSession } from './universe-scene';

/** Authored protocol fixtures only: a synthetic map served the way the sky and per-system reads answer. */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'sky@fixture.test' };
const recordedAt = '2026-10-21T00:00:00.000Z';
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1', 'worldmap.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  looks: ['scene-look.v1'],
  sky: [SCENE_SKY_VERSION],
  detail: 'full',
  reducedMotion: false,
};

const systemId = (index: number) => id(10_000 + index * 10);
const starId = (index: number) => id(10_001 + index * 10);
const planetId = (index: number, planet: 0 | 1) => id(10_002 + planet + index * 10);
const regionId = (index: number) => id(10_004 + index * 10);
const routeId = (index: number) => id(10_005 + index * 10);
const chunkId = (index: number) => id(900_000 + index);

/** `count` systems, each with a star, two planets, a region of the first planet and a route between the planets. */
function skyWorld(count: number) {
  const w = {
    count,
    geography: { revision: 5, structureRevision: 5, activityRevision: 0 },
    sceneRevision: 20,
    personalWatermark: 50,
    revisionOf: Array.from({ length: count }, () => 8),
    labelOf: Array.from({ length: count }, (_, index) => `System ${index}`),
    status: 'ready' as 'ready' | 'lagging' | 'loading' | 'empty' | 'unavailable' | 'unsupported_version',
    /** A change to system `index`: its revision and the map's move on together. */
    touch(index: number, label: string) {
      w.geography = {
        revision: w.geography.revision + 1,
        structureRevision: w.geography.structureRevision + 1,
        activityRevision: w.geography.activityRevision,
      };
      w.sceneRevision += 1;
      w.revisionOf[index] = w.sceneRevision;
      w.labelOf[index] = label;
    },
  };
  const geographyObjects = (index: number): GeographyObject[] => {
    const common = { objectRevision: 1, truthStatus: 'factual' as const, originTransitionId: id(9) };
    const activity = { availability: 'available' as const, state: 'active' as const };
    return [
      {
        ...common,
        id: systemId(index),
        kind: 'system',
        label: w.labelOf[index]!,
        activity,
        parent: { kind: 'universe', id: account.universeId },
      },
      {
        ...common,
        id: starId(index),
        kind: 'star',
        label: `Star ${index}`,
        activity,
        parent: { kind: 'system', id: systemId(index) },
      },
      {
        ...common,
        id: planetId(index, 0),
        kind: 'planet',
        label: `Planet ${index}a`,
        activity,
        parent: { kind: 'system', id: systemId(index) },
      },
      {
        ...common,
        id: planetId(index, 1),
        kind: 'planet',
        label: `Planet ${index}b`,
        activity,
        parent: { kind: 'system', id: systemId(index) },
      },
      {
        ...common,
        id: regionId(index),
        kind: 'region',
        label: `Region ${index}`,
        activity,
        parent: { kind: 'planet', id: planetId(index, 0) },
      },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)) as GeographyObject[];
  };
  const descriptors = (index: number): SceneDescriptor[] =>
    geographyObjects(index).map((o, n) => ({
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
      anchor: { x: (index % 50) * 900 + n * 0, y: Math.floor(index / 50) * 900, layer: o.kind === 'system' ? 0 : 2 },
      target: { kind: o.kind, objectId: o.id },
    }));
  const revisions = () => ({
    geographyRevision: w.geography.revision,
    structureRevision: w.geography.structureRevision,
    activityRevision: w.geography.activityRevision,
    sceneRevision: w.sceneRevision,
    personalRevision: 45,
  });
  const chunk = (index: number): SceneChunk => ({
    schemaVersion: 'scene-chunk.v1',
    chunkId: chunkId(index),
    revisions: { ...revisions(), sceneRevision: w.revisionOf[index]! },
    objects: descriptors(index),
    routes: [
      {
        id: routeId(index),
        fromObjectId: planetId(index, 0),
        toObjectId: planetId(index, 1),
        originTransitionId: id(9),
        truthStatus: 'factual',
      },
    ],
  });
  const looks = (index: number): SceneLook[] => {
    const base = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1' } as const;
    return [
      { ...base, objectId: systemId(index), kind: 'system', haze: 'teal' },
      ...([0, 1] as const).map((planet): SceneLook => ({
        ...base,
        objectId: planetId(index, planet),
        kind: 'planet',
        type: 'lush',
        rings: false,
        moon: false,
        hueShift: 0,
        variant: planet,
        siteCount: 6,
      })),
      { ...base, objectId: regionId(index), kind: 'region', site: 0 },
    ];
  };
  const indexOfSystem = (systemIdValue: string) =>
    Array.from({ length: w.count }, (_, n) => n).find((n) => systemId(n) === systemIdValue);
  return { w, geographyObjects, descriptors, chunk, looks, indexOfSystem, revisions };
}
type SkyWorld = ReturnType<typeof skyWorld>;

interface Call {
  path: string;
  body: Record<string, unknown>;
}
type Handler = (call: Call, fallback: () => unknown) => unknown;
const scopes: AccountScope[] = [],
  sessions: UniverseSceneSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const s of scopes.splice(0)) s.end();
});

function harness(world: SkyWorld, handler?: Handler) {
  const { w } = world;
  const calls: Call[] = [];
  const envelope = (body: Record<string, unknown>) => ({
    scope: { universeId: account.universeId, privacyEpoch: 1, personalWatermark: w.personalWatermark },
    recordedAt,
    currentGeography: w.geography,
    sceneRevision: w.sceneRevision,
    capabilities: body['capabilities'],
  });
  const sky = (body: Record<string, unknown>) => {
    const since = body['sinceSceneRevision'] as number | undefined;
    const cursor = body['cursor'] as { sceneRevision: number; afterSystemId: string } | undefined;
    const fields = {
      version: 'scene-sky-read.v1',
      ...envelope(body),
      ...(since === undefined ? {} : { sinceSceneRevision: since }),
    };
    if (w.status === 'unsupported_version') return { ...fields, status: 'unsupported_version' };
    if (w.status === 'unavailable') return { ...fields, status: 'unavailable', reason: 'temporarily_unavailable' };
    if (w.status === 'empty') return { ...fields, status: 'empty' };
    if (cursor && cursor.sceneRevision !== w.sceneRevision)
      return { ...fields, status: 'unavailable', reason: 'snapshot_expired' };
    const all = Array.from({ length: w.count }, (_, n) => n)
      .filter((n) => since === undefined || w.revisionOf[n]! > since)
      .sort((a, b) => (systemId(a) < systemId(b) ? -1 : 1))
      .filter((n) => cursor === undefined || systemId(n) > cursor.afterSystemId);
    const page = all.slice(0, body['limit'] as number);
    const systems = page.map((n) => ({
      descriptor: world.descriptors(n).find((d) => d.kind === 'system')!,
      haze: 'teal',
      planetCount: 2,
      sceneRevision: w.revisionOf[n]!,
    }));
    const pending = { geographyRevision: w.geography.revision, personalRevision: 45 };
    if (w.status === 'loading') return { ...fields, status: 'loading', pendingProjection: pending };
    const revisions =
      w.status === 'lagging'
        ? {
            ...world.revisions(),
            geographyRevision: w.geography.revision - 1,
            structureRevision: w.geography.structureRevision - 1,
          }
        : world.revisions();
    return {
      ...fields,
      status: w.status,
      revisions,
      systems,
      continuation:
        all.length > page.length
          ? {
              status: 'more',
              cursor: { sceneRevision: w.sceneRevision, afterSystemId: systems.at(-1)!.descriptor.objectId },
            }
          : { status: 'complete' },
      ...(w.status === 'lagging' ? { pendingProjection: pending } : {}),
    };
  };
  const indexesOf = (body: Record<string, unknown>): number[] | undefined => {
    const selection = body['selection'] as { kind: 'universe' } | { kind: 'system'; systemId: string };
    if (selection.kind === 'universe') return Array.from({ length: w.count }, (_, n) => n);
    const index = world.indexOfSystem(selection.systemId);
    return index === undefined ? undefined : [index];
  };
  const routeOf = (index: number) => ({
    id: routeId(index),
    kind: 'route' as const,
    relationRevision: 2,
    originTransitionId: id(9),
    status: 'current' as const,
    fromObjectId: planetId(index, 0),
    toObjectId: planetId(index, 1),
    truthStatus: 'factual' as const,
  });
  // The longest chain of requests, counting a request as one round after the latest that had finished when it began.
  let finishedRound = 0,
    longestChain = 0;
  const fetch = vi.fn(async (request: Request) => {
    const round = finishedRound + 1;
    longestChain = Math.max(longestChain, round);
    const call = { path: new URL(request.url).pathname, body: (await request.json()) as Record<string, unknown> };
    calls.push(call);
    const fallback = () => {
      if (call.path.endsWith('/scenes/sky/read')) return sky(call.body);
      const indexes = indexesOf(call.body);
      if (indexes === undefined) return problemDetails('NOT_FOUND');
      if (call.path.endsWith('/geography/read')) {
        // `geography-read.v2` carries no routes in the universe selection; without it every page carries them all.
        const v2 = call.body['version'] === 'geography-read.v2';
        const selection = call.body['selection'] as { kind: string };
        const after = (call.body['cursor'] as { afterObjectId: string } | undefined)?.afterObjectId ?? '';
        const remaining = indexes
          .flatMap((index) => world.geographyObjects(index))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((o) => o.id > after);
        const page = remaining.slice(0, call.body['limit'] as number);
        return {
          version: 'geography-snapshot.v1',
          universeId: account.universeId,
          privacyEpoch: 1,
          personalWatermark: w.personalWatermark,
          recordedAt,
          geography: w.geography,
          selection,
          status: 'ready',
          page: {
            objects: page,
            routes: v2 && selection.kind === 'universe' ? [] : indexes.map(routeOf),
            aliases: [],
            continuation:
              remaining.length > page.length
                ? {
                    status: 'more',
                    cursor: {
                      universeId: account.universeId,
                      privacyEpoch: 1,
                      geographyRevision: w.geography.revision,
                      selection,
                      afterObjectId: page.at(-1)!.id,
                    },
                  }
                : { status: 'complete' },
          },
        };
      }
      if (call.path.endsWith('/scenes/manifest/read'))
        return {
          version: 'scene-manifest-read.v1',
          ...envelope(call.body),
          selection: call.body['selection'],
          status: 'ready',
          manifest: {
            schemaVersion: 'scene-manifest.v1',
            revisions: world.revisions(),
            chunks: indexes.map((index) => ({
              chunkId: chunkId(index),
              sceneRevision: w.revisionOf[index]!,
              objectIds: world.descriptors(index).map((d) => d.objectId),
            })),
          },
          ...(call.body['capabilities'] && (call.body['capabilities'] as { looks?: unknown }).looks
            ? { looks: indexes.flatMap((index) => world.looks(index)) }
            : {}),
        };
      const asked = (call.body['reference'] as { chunkId: string }).chunkId;
      const owner = Array.from({ length: w.count }, (_, n) => n).find((n) => chunkId(n) === asked) ?? indexes[0]!;
      return {
        version: 'scene-chunk-read.v1',
        ...envelope(call.body),
        selection: call.body['selection'],
        reference: call.body['reference'],
        status: 'ready',
        chunk: world.chunk(owner),
      };
    };
    const reply = handler ? await handler(call, fallback) : fallback();
    finishedRound = Math.max(finishedRound, round);
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const scope = createAccountScope({
    account,
    baseUrl: 'https://sky.fixture.test',
    fetch,
    authorization: () => undefined,
    store: memoryStore(),
  });
  scopes.push(scope);
  const make = (caps = capabilities) => {
    const session = createUniverseSceneSession({ scope, capabilities: caps });
    sessions.push(session);
    return session;
  };
  const only = (suffix: string) => calls.filter((call) => call.path.endsWith(suffix));
  return { calls, fetch, scope, make, only, rounds: () => longestChain };
}
async function settled(session: UniverseSceneSession, status = 'ready') {
  await vi.waitFor(() => expect(session.getState().status).toBe(status), { timeout: 5000 });
  return session.getState();
}
const loadedIds = (session: UniverseSceneSession) => session.getState().loadedSystemIds ?? [];
const waitLoaded = (session: UniverseSceneSession, expected: readonly string[]) =>
  vi.waitFor(() => expect([...loadedIds(session)].sort()).toEqual([...expected].sort()), { timeout: 5000 });

describe('sky-capable Universe session (authored CI fixtures)', () => {
  it('reads the sky first and loads only the systems it is asked for', async () => {
    const world = skyWorld(40),
      h = harness(world),
      s = h.make();
    s.start();
    const state = await settled(s);
    expect(state.sky?.systems).toHaveLength(40);
    expect(state.sky?.sceneRevision).toBe(20);
    expect(state.loadedSystemIds).toEqual([]);
    expect(state.snapshot?.chunks).toEqual([]);
    expect(state.geography?.objects).toEqual([]);
    // Only the sky was asked for; a haze came with each entry and is a look of the composed read.
    expect(h.calls.map((call) => call.path)).toEqual(['/v1/universe/scenes/sky/read']);
    expect(state.snapshot?.read.looks?.filter((look) => look.kind === 'system')).toHaveLength(40);
    expect(h.calls[0]!.body).toMatchObject({ limit: 200 });
    expect(h.calls[0]!.body).not.toHaveProperty('sinceSceneRevision');

    s.want([systemId(7)]);
    await waitLoaded(s, [systemId(7)]);
    const loaded = s.getState();
    expect(loaded.snapshot?.chunks).toHaveLength(1);
    expect(loaded.snapshot?.chunks[0]?.chunkId).toBe(chunkId(7));
    expect(loaded.geography?.objects).toHaveLength(5);
    expect(loaded.geography?.routes).toHaveLength(1);
    expect(loaded.snapshot?.read.manifest.chunks).toHaveLength(1);
    // The planets' looks come with their system, the other systems keep the sky's haze.
    expect(loaded.snapshot?.read.looks?.filter((look) => look.kind === 'planet')).toHaveLength(2);
    const asked = h.calls.slice(1);
    expect(asked.map((call) => call.path)).toEqual([
      '/v1/universe/geography/read',
      '/v1/universe/scenes/manifest/read',
      '/v1/universe/scenes/chunks/read',
    ]);
    expect(asked[0]!.body).toMatchObject({
      selection: { kind: 'system', systemId: systemId(7) },
      version: 'geography-read.v2',
    });
    expect(asked[1]!.body).toMatchObject({ selection: { kind: 'system', systemId: systemId(7) } });
  });

  it('loads a map of at most 24 systems whole, without being asked', async () => {
    const h = harness(skyWorld(UNIVERSE_SCENE_LIMITS.loadedSystems)),
      s = h.make();
    s.start();
    await waitLoaded(
      s,
      Array.from({ length: UNIVERSE_SCENE_LIMITS.loadedSystems }, (_, n) => systemId(n)),
    );
    expect(s.getState().snapshot?.chunks).toHaveLength(UNIVERSE_SCENE_LIMITS.loadedSystems);
    expect(h.only('/scenes/sky/read')).toHaveLength(1);
    // The same session shape as ever: the composed manifest names every loaded chunk.
    expect(s.getState().snapshot?.read.manifest.chunks).toHaveLength(UNIVERSE_SCENE_LIMITS.loadedSystems);
  });

  describe('a small map costs what it always cost, plus the sky read', () => {
    /** Starts a session on a map of `count` systems and waits until everything it will load on its own is in. */
    const measure = async (count: number, withSky: boolean) => {
      const h = harness(skyWorld(count)),
        s = h.make(withSky ? capabilities : { ...capabilities, sky: undefined });
      s.start();
      await settled(s);
      if (withSky && count <= UNIVERSE_SCENE_LIMITS.loadedSystems)
        await waitLoaded(
          s,
          Array.from({ length: count }, (_, n) => systemId(n)),
        );
      return { h, s, requests: h.calls.length, rounds: h.rounds() };
    };

    it.each([1, 6, 24])(
      'reads %i systems in one whole-map pass: the old requests and rounds, plus the sky read',
      async (count) => {
        const old = await measure(count, false),
          sky = await measure(count, true);
        // The sky read is the only added request and the only added round.
        expect(sky.requests).toBe(old.requests + 1);
        expect(sky.rounds).toBe(old.rounds + 1);
        expect(sky.h.calls[0]!.path).toBe('/v1/universe/scenes/sky/read');
        // The rest is the whole-map read, as the server has always answered it: the universe selection, no version.
        const rest = sky.h.calls.slice(1);
        expect(rest.map((call) => call.path)).toEqual(old.h.calls.map((call) => call.path));
        expect(rest.every((call) => (call.body['selection'] as { kind: string }).kind === 'universe')).toBe(true);
        expect(sky.h.only('/geography/read').every((call) => !('version' in call.body))).toBe(true);
        expect(sky.h.only('/scenes/manifest/read')).toHaveLength(1);
        // Everything is in hand and split into the systems the session keeps.
        expect(sky.s.getState().loadedSystemIds).toHaveLength(count);
        expect(sky.s.getState().snapshot?.chunks).toHaveLength(count);
        expect(sky.s.getState().geography?.objects).toHaveLength(count * 5);
        expect(sky.s.getState().geography?.routes).toHaveLength(count);
        expect(old.s.getState().snapshot?.chunks).toHaveLength(count);
      },
    );

    it('reads 25 systems one system at a time, and only the ones that are wanted', async () => {
      const size = UNIVERSE_SCENE_LIMITS.loadedSystems + 1;
      const { h, s } = await measure(size, true);
      expect(h.calls.map((call) => call.path)).toEqual(['/v1/universe/scenes/sky/read']);
      expect(s.getState().loadedSystemIds).toEqual([]);
      const wanted = Array.from({ length: size }, (_, n) => systemId(n));
      s.want(wanted);
      await waitLoaded(s, wanted);
      // Each system is its own selection, and none of the reads is a whole-map read.
      const reads = [...h.only('/geography/read'), ...h.only('/scenes/manifest/read')];
      expect(reads.every((call) => (call.body['selection'] as { kind: string }).kind === 'system')).toBe(true);
      expect(h.only('/geography/read').every((call) => call.body['version'] === 'geography-read.v2')).toBe(true);
      expect(h.only('/geography/read')).toHaveLength(size);
      // Several systems are in flight together, so the wanted set is not one long chain.
      expect(h.rounds()).toBeLessThan(1 + size * 3);
    });

    it('keeps what it holds and reads one system at a time when a small map grows past the threshold', async () => {
      const world = skyWorld(UNIVERSE_SCENE_LIMITS.loadedSystems),
        h = harness(world),
        s = h.make();
      s.start();
      await settled(s);
      const first = Array.from({ length: UNIVERSE_SCENE_LIMITS.loadedSystems }, (_, n) => systemId(n));
      await waitLoaded(s, first);
      const before = h.calls.length;
      // Six more systems are established: the map has 30 now.
      const w = world.w;
      w.count += 6;
      w.revisionOf.push(...Array.from({ length: 6 }, () => w.sceneRevision + 1));
      w.labelOf.push(...Array.from({ length: 6 }, (_, n) => `System ${w.count - 6 + n}`));
      w.geography = {
        revision: w.geography.revision + 1,
        structureRevision: w.geography.structureRevision + 1,
        activityRevision: w.geography.activityRevision,
      };
      w.sceneRevision += 1;
      await s.refresh();
      // The refresh is the sky read since the revision held, and nothing more: the 24 are not read again.
      expect(h.calls.slice(before).map((call) => call.path)).toEqual(['/v1/universe/scenes/sky/read']);
      expect(s.getState().sky?.systems).toHaveLength(30);
      expect(s.getState().loadedSystemIds).toHaveLength(UNIVERSE_SCENE_LIMITS.loadedSystems);
      // A new system is read as a system of its own.
      s.want([systemId(27)]);
      await vi.waitFor(() => expect(loadedIds(s)).toContain(systemId(27)));
      const read = h.calls.slice(before).filter((call) => call.path.endsWith('/geography/read'));
      expect(read).toHaveLength(1);
      expect(read[0]!.body).toMatchObject({ selection: { kind: 'system' }, version: 'geography-read.v2' });
    });
  });

  it('draws a small map once all its planets are in, not system by system', async () => {
    const world = skyWorld(4);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(world, async (call, fallback) => {
      if (call.path.endsWith('/chunks/read')) await gate;
      return fallback();
    });
    const s = h.make();
    const seen: string[] = [];
    s.subscribe(() => seen.push(`${s.getState().status}:${s.getState().snapshot?.chunks.length ?? '-'}`));
    s.start();
    await vi.waitFor(() => expect(h.only('/chunks/read').length).toBeGreaterThan(0));
    // The sky is read and planets are on their way, but nothing is drawn yet.
    expect(s.getState().status).toBe('loading');
    expect(s.getState().snapshot).toBeUndefined();
    release();
    await waitLoaded(s, [0, 1, 2, 3].map(systemId));
    expect(s.getState().status).toBe('ready');
    expect(seen).not.toContain('ready:1');
    expect(seen).not.toContain('ready:0');
  });

  it('loads several systems at once, up to the bound, and never more', async () => {
    const world = skyWorld(40);
    let running = 0,
      maximum = 0;
    const h = harness(world, async (call, fallback) => {
      if (!call.path.endsWith('/geography/read')) return fallback();
      running++;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running--;
      return fallback();
    });
    const s = h.make();
    s.start();
    await settled(s);
    s.want(Array.from({ length: 8 }, (_, n) => systemId(n)));
    await waitLoaded(
      s,
      Array.from({ length: 8 }, (_, n) => systemId(n)),
    );
    expect(maximum).toBe(UNIVERSE_SCENE_LIMITS.concurrentSystems);
  });

  it('lets go of systems that are no longer wanted, oldest first, beyond the ones it keeps', async () => {
    const world = skyWorld(100),
      h = harness(world),
      s = h.make();
    s.start();
    await settled(s);
    const first = Array.from({ length: 30 }, (_, n) => systemId(n));
    s.want(first);
    await waitLoaded(s, first);
    // Nobody wants them now: the 24 most recently wanted are kept for a moment, the six oldest go.
    s.want([systemId(50)]);
    await waitLoaded(s, [...first.slice(6), systemId(50)]);
    expect(loadedIds(s)).toHaveLength(UNIVERSE_SCENE_LIMITS.loadedSystems + 1);
    // What is dropped leaves the composed state too.
    expect(s.getState().snapshot?.chunks.some((chunk) => chunk.chunkId === chunkId(0))).toBe(false);
    expect(s.getState().sky?.systems).toHaveLength(100);
    // Asking for a dropped system loads it again.
    s.want([systemId(0)]);
    await vi.waitFor(() => expect(loadedIds(s)).toContain(systemId(0)), { timeout: 5000 });
  });

  it('refreshes by the revision it holds and reloads only the loaded systems that changed', async () => {
    const world = skyWorld(40),
      h = harness(world),
      s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(1), systemId(2)]);
    await waitLoaded(s, [systemId(1), systemId(2)]);
    const before = h.calls.length;
    // A system that is loaded and one that is not both change.
    world.w.touch(1, 'Renamed one');
    world.w.touch(30, 'Renamed thirty');
    await s.refresh();
    await vi.waitFor(
      () => {
        const label = s.getState().geography?.objects.find((o) => o.id === systemId(1))?.label;
        expect(label).toBe('Renamed one');
      },
      { timeout: 5000 },
    );
    const asked = h.calls.slice(before);
    expect(asked[0]!.path).toBe('/v1/universe/scenes/sky/read');
    expect(asked[0]!.body).toMatchObject({ sinceSceneRevision: 20 });
    const systemsAsked = new Set(
      asked
        .filter((call) => !call.path.endsWith('/sky/read'))
        .map((call) => (call.body['selection'] as { systemId: string }).systemId),
    );
    expect([...systemsAsked]).toEqual([systemId(1)]);
    const state = s.getState();
    // The sky holds the new label of the unloaded system and the new revision of both.
    expect(state.sky?.systems.find((x) => x.descriptor.objectId === systemId(30))?.descriptor.label).toBe(
      'Renamed thirty',
    );
    expect(state.sky?.sceneRevision).toBe(world.w.sceneRevision);
    expect(state.snapshot?.chunks.find((chunk) => chunk.chunkId === chunkId(2))?.revisions.sceneRevision).toBe(8);
  });

  it('reads the manifest again once when a chunk says the manifest is stale', async () => {
    const world = skyWorld(40);
    let stale = 1;
    const h = harness(world, (call, fallback) => {
      if (call.path.endsWith('/chunks/read') && stale-- > 0)
        return {
          ...(fallback() as object),
          status: 'unavailable',
          reason: 'stale_manifest',
          chunk: undefined,
        };
      return fallback();
    });
    const s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(3)]);
    await waitLoaded(s, [systemId(3)]);
    expect(h.only('/scenes/manifest/read')).toHaveLength(2);
  });

  it('keeps a system that fails out of the map, says so, and goes on with the others', async () => {
    const world = skyWorld(40),
      h = harness(world, (call, fallback) => {
        if (
          call.path.endsWith('/chunks/read') &&
          (call.body['selection'] as { systemId: string }).systemId === systemId(4)
        )
          return { ...(fallback() as object), status: 'unavailable', reason: 'limit', chunk: undefined };
        return fallback();
      }),
      s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(4), systemId(5)]);
    await waitLoaded(s, [systemId(5)]);
    await vi.waitFor(() => expect(s.getState().failedSystemIds).toEqual([systemId(4)]));
    expect(s.getState().status).toBe('ready');
    expect(s.getState().sky?.systems).toHaveLength(40);
    // A failed system is not asked for again on every pump; asking for it again tries it.
    const asked = h.only('/geography/read').length;
    s.want([systemId(5)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.only('/geography/read')).toHaveLength(asked);
    s.want([systemId(4), systemId(5)]);
    await vi.waitFor(() => expect(h.only('/geography/read').length).toBeGreaterThan(asked));
  });

  it('refuses a system whose geography names another system', async () => {
    const world = skyWorld(40),
      h = harness(world, (call, fallback) => {
        if (call.path.endsWith('/geography/read')) {
          const reply = fallback() as { page: { objects: GeographyObject[] } };
          reply.page.objects = world.geographyObjects(9);
          return reply;
        }
        return fallback();
      }),
      s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(8)]);
    await vi.waitFor(() => expect(s.getState().failedSystemIds).toEqual([systemId(8)]));
    expect(s.getState().loadedSystemIds).toEqual([]);
  });

  it('pages the sky and reads it again when the map changes under a page', async () => {
    const world = skyWorld(450);
    let moved = false;
    const h = harness(world, (call, fallback) => {
      if (call.path.endsWith('/sky/read') && call.body['cursor'] && !moved) {
        moved = true;
        // The map moves between the first and second page.
        world.w.touch(0, 'Moved');
      }
      return fallback();
    });
    const s = h.make();
    s.start();
    const state = await settled(s);
    expect(state.sky?.systems).toHaveLength(450);
    // First page, the expired second page, then a whole read again: 200 + 200 + 50.
    expect(h.only('/scenes/sky/read').length).toBe(1 + 1 + 3);
    expect(state.sky?.systems.map((x) => x.descriptor.objectId)).toEqual(
      [...(state.sky?.systems ?? [])].map((x) => x.descriptor.objectId).sort(),
    );
    expect(state.sky?.sceneRevision).toBe(world.w.sceneRevision);
  });

  it('says an empty map is empty, with no systems', async () => {
    const empty = skyWorld(0);
    empty.w.status = 'empty';
    const e = harness(empty).make();
    e.start();
    const state = await settled(e, 'empty');
    expect(state.snapshot?.chunks).toEqual([]);
    expect(state.snapshot?.read.status).toBe('empty');
    expect(state.sky?.systems).toEqual([]);
    expect(state.geography?.status).toBe('empty');
  });

  it('keeps a map that is still being projected distinct from an empty one', async () => {
    const loading = skyWorld(3);
    loading.w.status = 'loading';
    const l = harness(loading).make();
    l.start();
    const state = await settled(l, 'loading');
    await vi.waitFor(() =>
      expect(l.getState().pendingProjection).toEqual({ geographyRevision: 5, personalRevision: 45 }),
    );
    expect(state.snapshot).toBeUndefined();
  });

  it('draws the last projection while a newer one is pending', async () => {
    const lagging = skyWorld(3);
    lagging.w.status = 'lagging';
    const g = harness(lagging).make();
    g.start();
    const state = await settled(g, 'lagging');
    expect(state.pendingProjection).toEqual({ geographyRevision: 5, personalRevision: 45 });
    expect(state.snapshot?.read.status).toBe('lagging');
    expect(state.geography?.status).toBe('lagging');
    expect(state.sky?.systems).toHaveLength(3);
  });

  it('says a sky it cannot read is unavailable, and refuses an answer that contradicts what it declared', async () => {
    const unavailable = skyWorld(3);
    unavailable.w.status = 'unavailable';
    const u = harness(unavailable).make();
    u.start();
    expect((await settled(u, 'unavailable')).reason).toBe('temporarily_unavailable');

    // It declared the sky, so "unsupported version" is not an answer the server can give it.
    const contradiction = skyWorld(3);
    contradiction.w.status = 'unsupported_version';
    const x = harness(contradiction).make();
    x.start();
    expect((await settled(x, 'unavailable')).reason).toBe('invalid');
  });

  it('refuses a sky that names a place that is not a system of this universe', async () => {
    const h = harness(skyWorld(5), (call, fallback) => {
      const reply = fallback() as { systems?: { descriptor: SceneDescriptor }[] };
      if (call.path.endsWith('/sky/read') && reply.systems)
        reply.systems[0] = {
          ...reply.systems[0]!,
          descriptor: { ...reply.systems[0]!.descriptor, parentId: id(777) },
        };
      return reply;
    });
    const s = h.make();
    s.start();
    expect((await settled(s, 'unavailable')).reason).toBe('invalid');
    expect(s.getState().sky).toBeUndefined();
  });

  it('keeps the last map while a refresh fails on the network and drops everything on a refusal of authority', async () => {
    const world = skyWorld(30);
    let mode: 'ok' | 'offline' | 'forbidden' = 'ok';
    const h = harness(world, (call, fallback) => {
      if (mode === 'offline') throw new TypeError('offline');
      if (mode === 'forbidden') return Response.json(problemDetails('UNIVERSE_UNAVAILABLE'), { status: 403 });
      return fallback();
    });
    const s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(1)]);
    await waitLoaded(s, [systemId(1)]);
    mode = 'offline';
    await s.refresh();
    const offline = await settled(s, 'unavailable');
    expect(offline.reason).toBe('network');
    expect(offline.sky?.systems).toHaveLength(30);
    expect(offline.loadedSystemIds).toEqual([systemId(1)]);
    mode = 'forbidden';
    await s.refresh();
    const refused = await vi.waitFor(() => {
      const state = s.getState();
      expect(state.reason).toBe('authority');
      return state;
    });
    expect(refused.sky).toBeUndefined();
    expect(refused.snapshot).toBeUndefined();
    expect(refused.geography).toBeUndefined();
  });

  it('purges the sky and every loaded system when the scope ends, and asks for nothing after', async () => {
    const world = skyWorld(40),
      h = harness(world),
      s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(1)]);
    await waitLoaded(s, [systemId(1)]);
    const asked = h.calls.length;
    h.scope.end();
    const ended = s.getState();
    expect(ended).toEqual({ status: 'ended', active: false });
    s.want([systemId(2)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls).toHaveLength(asked);
    expect(
      h.scope.queryClient
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes('universe-scene')),
    ).toEqual([]);
  });

  it('does not load while paused, keeps what it holds and loads what was wanted when it resumes', async () => {
    const world = skyWorld(40),
      h = harness(world),
      s = h.make();
    s.start();
    await settled(s);
    s.want([systemId(1)]);
    await waitLoaded(s, [systemId(1)]);
    s.pause();
    expect(s.getState().active).toBe(false);
    expect(s.getState().loadedSystemIds).toEqual([systemId(1)]);
    const paused = h.calls.length;
    s.want([systemId(2)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls).toHaveLength(paused);
    s.resume();
    await waitLoaded(s, [systemId(1), systemId(2)]);
  });

  it('freezes what it publishes', async () => {
    const world = skyWorld(3),
      h = harness(world),
      s = h.make();
    s.start();
    const state = await settled(s);
    await waitLoaded(s, [systemId(0), systemId(1), systemId(2)]);
    expect(() => {
      state.sky!.systems[0]!.descriptor.label = 'mutated';
    }).toThrow();
    expect(Object.isFrozen(s.getState().snapshot?.chunks)).toBe(true);
  });

  it('holds the sky of 3,000 systems and loads one of them without building the others', async () => {
    const world = skyWorld(3000),
      h = harness(world),
      s = h.make();
    s.start();
    const state = await settled(s);
    expect(state.sky?.systems).toHaveLength(3000);
    expect(h.only('/scenes/sky/read')).toHaveLength(15);
    expect(state.loadedSystemIds).toEqual([]);
    expect(state.snapshot?.chunks).toEqual([]);
    expect(state.geography?.objects).toEqual([]);
    s.want([systemId(1234)]);
    await waitLoaded(s, [systemId(1234)]);
    const after = s.getState();
    expect(after.snapshot?.chunks).toHaveLength(1);
    expect(after.geography?.objects).toHaveLength(5);
    // One system cost three requests; the other 2,999 cost none.
    expect(h.calls.filter((call) => !call.path.endsWith('/sky/read'))).toHaveLength(3);
    // Every system is still a label and a place, so search and the outline can list them.
    expect(after.sky?.systems.find((x) => x.descriptor.objectId === systemId(2999))?.descriptor.label).toBe(
      'System 2999',
    );
  });

  it('is not used by a client that did not declare the sky: it keeps the whole-map protocol', async () => {
    const world = skyWorld(3),
      h = harness(world),
      s = h.make({ ...capabilities, sky: undefined });
    s.start();
    await vi.waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
    expect(h.calls[0]!.path).toBe('/v1/universe/geography/read');
    expect(h.calls[0]!.body).not.toHaveProperty('version');
    expect(h.only('/scenes/sky/read')).toHaveLength(0);
  });
});
