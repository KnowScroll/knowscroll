import { QueryObserver } from '@tanstack/react-query';
import { ORPCError } from '@orpc/client';
import {
  GeographySnapshotSchema,
  ReadSceneManifestSchema,
  SceneChunkReadSchema,
  SceneChunkSchema,
  SceneManifestReadSchema,
  SceneManifestSchema,
  SceneSkyReadSchema,
  SCENE_LOOK_VERSION,
  SKY_LIMITS,
  WORLD_GENERATOR_VERSION,
  type GeographyAlias,
  type GeographyObject,
  type GeographyRoute,
  type GeographySnapshot,
  type ReadGeography,
  type ReadSceneSky,
  type SceneChunk,
  type SceneClientCapabilities,
  type SceneLook,
  type SceneSkyRead,
  type SceneSkySystem,
} from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import { ScopeEndedError, type AccountScope } from './account-scope';
import {
  abortable,
  bytes,
  equal,
  fail,
  frozen,
  ReadFailure,
  SYSTEM_LIMITS,
  UNIVERSE_SCENE_LIMITS,
  WHOLE_MAP_LIMITS,
  validateGeography,
  validateScene,
  type ManifestData,
  type UniverseGeography,
  type UniverseSceneReason,
  type UniverseSceneSession,
  type UniverseSceneState,
} from './universe-scene-shared';

/**
 * The session of a client that declared `scene-sky.v1` (D-417): a map of any size is read as its sky first, every
 * system in one compact entry, and then one system at a time. `want` names the systems whose planets, regions and
 * routes are loaded; the others stay a sky entry (a label, a place and a haze). A map of at most
 * `UNIVERSE_SCENE_LIMITS.loadedSystems` systems loads whole, so a small universe is drawn exactly as it always was.
 *
 * `UniverseSceneState` keeps its shape: `geography` and `snapshot` hold the loaded systems, `snapshot.read` is a
 * manifest read composed of the sky's stamps and the loaded chunks, and `sky` lists every system.
 */

type ReadOptions = {
  readonly scope: AccountScope;
  readonly capabilities: SceneClientCapabilities;
};

/** What the last sky read said, apart from the systems themselves. */
interface SkyData {
  readonly kind: 'map' | 'empty';
  readonly scope: SceneSkyRead['scope'];
  readonly recordedAt: string;
  readonly currentGeography: SceneSkyRead['currentGeography'];
  readonly sceneRevision: number;
  readonly revisions: {
    readonly geographyRevision: number;
    readonly structureRevision: number;
    readonly activityRevision: number;
    readonly sceneRevision: number;
    readonly personalRevision: number;
  };
  readonly pending?: { readonly geographyRevision: number; readonly personalRevision: number };
}

/** One system with its planets, as read and validated. */
interface LoadedSystem {
  readonly systemId: string;
  readonly geography: UniverseGeography;
  readonly chunks: readonly SceneChunk[];
  readonly looks: readonly SceneLook[];
  /** The global scene revision at the system's manifest read: the system changed after it when its sky entry is newer. */
  readonly readSceneRevision: number;
  readonly bytes: number;
}

type SkyOutcome =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unavailable'; readonly reason: 'limit' | 'temporarily_unavailable' }
  | { readonly kind: 'loading'; readonly pending: { geographyRevision: number; personalRevision: number } }
  | { readonly kind: 'empty'; readonly data: SkyData }
  | {
      readonly kind: 'map';
      readonly data: SkyData;
      readonly entries: readonly SceneSkySystem[];
      readonly incremental: boolean;
    };

interface Composite {
  readonly geography: UniverseGeography;
  readonly snapshot: NonNullable<UniverseSceneState['snapshot']>;
}

const AUTHORITY_STATUSES = [401, 403, 404, 409];
/** The planets a sky session is told to wait for have no limit of their own: a map this small is loaded whole. */
const eagerLimit = UNIVERSE_SCENE_LIMITS.loadedSystems;

let nextSession = 0;

export function createSkySceneSession(options: ReadOptions): UniverseSceneSession {
  const { scope } = options;
  const queryPrefix = scope.queryKey('universe-scene', ++nextSession);
  const listeners = new Set<() => void>();
  const capabilities = frozen(
    ReadSceneManifestSchema.parse({ selection: { kind: 'universe' }, capabilities: options.capabilities }).capabilities,
  );
  const universeId = scope.account.universeId;
  let state: UniverseSceneState = frozen({ status: 'idle', active: false });
  let active = false,
    ended = false,
    runGeneration = 0,
    loadGeneration = 0,
    running = false,
    autoRefreshedFor = -1,
    refreshRequested = false;
  let observer: QueryObserver<number> | undefined;
  let unsubscribeEnd: (() => void) | undefined;

  // The sky.
  let sky = new Map<string, SceneSkySystem>();
  let skyBytes = new Map<string, number>();
  let skyList: readonly SceneSkySystem[] | undefined;
  let data: SkyData | undefined;
  // The systems whose planets are loaded, and why and how they stay.
  const loaded = new Map<string, LoadedSystem>();
  const stale = new Set<string>();
  const failures = new Map<string, UniverseSceneReason>();
  const inFlight = new Map<string, AbortController>();
  let wanted = new Set<string>();
  const touched = new Map<string, number>();
  let tick = 0;
  let composite: Composite | undefined;
  /** A small map is first drawn once its planets are in, so it appears as it always did, not system by system. */
  let firstDrawn = false;

  const effectiveWanted = (): ReadonlySet<string> => (sky.size <= eagerLimit ? new Set(sky.keys()) : wanted);
  const invalidate = () => {
    composite = undefined;
  };

  /** The loaded systems in the order of the sky, so what is composed does not depend on the order they arrived in. */
  const loadedInOrder = () => [...loaded.values()].sort((a, b) => (a.systemId < b.systemId ? -1 : 1));
  const build = (): Composite | undefined => {
    if (!data) return undefined;
    const systems = loadedInOrder();
    const objects = systems.flatMap((system) => system.geography.objects);
    const looks = new Map<string, SceneLook>();
    for (const entry of sky.values())
      if (entry.haze !== undefined)
        looks.set(entry.descriptor.objectId, {
          schemaVersion: SCENE_LOOK_VERSION,
          generatorVersion: WORLD_GENERATOR_VERSION,
          objectId: entry.descriptor.objectId,
          kind: 'system',
          haze: entry.haze,
        });
    for (const system of systems) for (const look of system.looks) looks.set(look.objectId, look);
    const chunks = systems.flatMap((system) => system.chunks);
    const geography: UniverseGeography = {
      universeId: data.scope.universeId,
      privacyEpoch: data.scope.privacyEpoch,
      personalWatermark: Math.max(data.scope.personalWatermark, ...systems.map((s) => s.geography.personalWatermark)),
      geography: data.currentGeography,
      status: data.kind === 'empty' ? 'empty' : data.pending ? 'lagging' : 'ready',
      objects,
      routes: systems.flatMap((system) => system.geography.routes),
      aliases: systems.flatMap((system) => system.geography.aliases),
    };
    const read = {
      version: 'scene-manifest-read.v1',
      selection: { kind: 'universe' },
      capabilities,
      scope: data.scope,
      recordedAt: data.recordedAt,
      currentGeography: data.currentGeography,
      sceneRevision: data.sceneRevision,
      status: data.kind === 'empty' ? 'empty' : data.pending ? 'lagging' : 'ready',
      manifest: {
        schemaVersion: 'scene-manifest.v1',
        revisions: data.revisions,
        chunks: chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          sceneRevision: chunk.revisions.sceneRevision,
          objectIds: chunk.objects.map((object) => object.objectId),
        })),
      },
      looks: [...looks.values()],
      ...(data.pending && data.kind === 'map' ? { pendingProjection: data.pending } : {}),
    } as ManifestData;
    return frozen({ geography, snapshot: { read, chunks } });
  };
  const current = (): Composite | undefined => (composite ??= build());
  const skyOf = () => {
    skyList ??= frozen([...sky.values()].sort((a, b) => (a.descriptor.objectId < b.descriptor.objectId ? -1 : 1)));
    return skyList;
  };
  const parts = (): Partial<UniverseSceneState> => {
    const c = current();
    if (!c) return {};
    return {
      geography: c.geography,
      snapshot: c.snapshot,
      sky: { systems: skyOf(), sceneRevision: data!.sceneRevision },
      loadedSystemIds: loadedInOrder().map((system) => system.systemId),
      ...(failures.size ? { failedSystemIds: [...failures.keys()].sort() } : {}),
    };
  };
  const notify = (next: UniverseSceneState) => {
    state = frozen(next);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A view callback cannot break scope disposal. */
      }
    }
  };
  /** Publishes the standing map with `status`, as the session last drew it. */
  const publish = (
    status: UniverseSceneState['status'],
    extra: Pick<UniverseSceneState, 'reason' | 'pendingProjection'> = {},
  ) => notify({ status, active, ...parts(), ...extra });
  const settledStatus = (): UniverseSceneState['status'] =>
    !data ? 'loading' : data.kind === 'empty' ? 'empty' : data.pending ? 'lagging' : 'ready';
  const eagerComplete = () =>
    sky.size > eagerLimit || [...sky.keys()].every((id) => loaded.has(id) || failures.has(id));
  const publishSettled = () => {
    if (data?.kind === 'map' && !firstDrawn) {
      if (!eagerComplete()) return;
      firstDrawn = true;
    }
    publish(settledStatus(), data?.pending && data.kind === 'map' ? { pendingProjection: data.pending } : {});
  };

  // `refresh` resolves once what the new sky made stale is read again.
  const idleWaiters: (() => void)[] = [];
  const needsLoad = () => {
    if (!active || !data || data.kind !== 'map') return false;
    for (const id of effectiveWanted())
      if (sky.has(id) && !failures.has(id) && (!loaded.has(id) || stale.has(id))) return true;
    return false;
  };
  const settleIdle = () => {
    if (inFlight.size === 0 && !needsLoad()) for (const waiter of idleWaiters.splice(0)) waiter();
  };
  const whenIdle = () =>
    inFlight.size === 0 && !needsLoad() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve));

  const stop = () => {
    for (const waiter of idleWaiters.splice(0)) waiter();
    runGeneration++;
    loadGeneration++;
    running = false;
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    observer?.destroy();
    observer = undefined;
    void scope.queryClient.cancelQueries({ queryKey: queryPrefix });
    scope.queryClient.removeQueries({ queryKey: queryPrefix });
  };
  /** Lets go of the map. What the person's screen wants is kept when the map is only empty for now. */
  const forget = (keepWanted = false) => {
    sky = new Map();
    skyBytes = new Map();
    skyList = undefined;
    data = undefined;
    loaded.clear();
    stale.clear();
    failures.clear();
    if (!keepWanted) {
      wanted = new Set();
      touched.clear();
    }
    firstDrawn = false;
    invalidate();
  };
  const dispose = () => {
    if (ended) return;
    ended = true;
    active = false;
    stop();
    forget();
    unsubscribeEnd?.();
    unsubscribeEnd = undefined;
    notify({ status: 'ended', active: false });
    listeners.clear();
  };

  const checkScope = (u: string, e: number) => {
    if (u !== scope.account.universeId || e !== scope.account.privacyEpoch) fail('authority');
  };
  // Fence a recognizable foreign envelope even when a later cross-field refinement fails.
  // Inspect own data properties only: this is refusal, never partial payload admission.
  const checkEnvelopeScope = (raw: unknown, nested = false) => {
    const own = (value: unknown, key: string): unknown => {
      if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
        return undefined;
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property && 'value' in property ? property.value : undefined;
    };
    const envelope = nested ? own(raw, 'scope') : raw;
    const u = own(envelope, 'universeId'),
      e = own(envelope, 'privacyEpoch');
    if (typeof u === 'string' && typeof e === 'number') checkScope(u, e);
  };

  // ---- The sky ------------------------------------------------------------------------------------------------

  const readSky = async (signal: AbortSignal, live: () => void, since: number | undefined): Promise<SkyOutcome> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries: SceneSkySystem[] = [];
      let cursor: ReadSceneSky['cursor'];
      let first: SceneSkyRead | undefined;
      let restart = false;
      let lastId = '';
      for (let page = 0; page < UNIVERSE_SCENE_LIMITS.skyPages; page++) {
        live();
        const raw = await abortable(signal, () =>
          scope.api.scenes.sky(
            {
              capabilities,
              limit: SKY_LIMITS.systemsPerPage,
              ...(since === undefined ? {} : { sinceSceneRevision: since }),
              ...(cursor === undefined ? {} : { cursor }),
            },
            { signal },
          ),
        );
        live();
        checkEnvelopeScope(raw, true);
        const parsed = SceneSkyReadSchema.safeParse(raw);
        if (!parsed.success) fail();
        const read = parsed.data;
        checkScope(read.scope.universeId, read.scope.privacyEpoch);
        if (!equal(read.capabilities, capabilities) || read.sinceSceneRevision !== since) fail();
        if (data && read.sceneRevision < data.sceneRevision) fail('refresh_required');
        if (read.status === 'unsupported_version') return { kind: 'unsupported' };
        if (read.status === 'unavailable') {
          if (read.reason === 'snapshot_expired') {
            restart = true;
            break;
          }
          return { kind: 'unavailable', reason: read.reason };
        }
        if (read.status === 'loading') return { kind: 'loading', pending: read.pendingProjection };
        if (read.status === 'empty') {
          if (page > 0) {
            restart = true;
            break;
          }
          return { kind: 'empty', data: skyData(read, undefined) };
        }
        if (
          first &&
          (read.sceneRevision !== first.sceneRevision || read.scope.personalWatermark < first.scope.personalWatermark)
        ) {
          restart = true;
          break;
        }
        first ??= read;
        for (const entry of read.systems) {
          const id = entry.descriptor.objectId;
          if (id <= lastId) fail('refresh_required');
          lastId = id;
          if (entry.descriptor.parentId !== universeId) fail();
        }
        entries.push(...read.systems);
        if (read.continuation.status === 'complete')
          return {
            kind: 'map',
            data: skyData(read, read.status === 'lagging' ? read.pendingProjection : undefined),
            entries,
            incremental: since !== undefined,
          };
        cursor = read.continuation.cursor;
      }
      if (!restart) fail('limit');
    }
    return fail('refresh_required');
  };
  const skyData = (
    read: Exclude<SceneSkyRead, { status: 'unsupported_version' | 'unavailable' | 'loading' }>,
    pending: SkyData['pending'],
  ): SkyData => ({
    kind: 'systems' in read ? 'map' : 'empty',
    scope: read.scope,
    recordedAt: read.recordedAt,
    currentGeography: read.currentGeography,
    sceneRevision: read.sceneRevision,
    revisions:
      'revisions' in read
        ? read.revisions
        : {
            geographyRevision: read.currentGeography.revision,
            structureRevision: read.currentGeography.structureRevision,
            activityRevision: read.currentGeography.activityRevision,
            sceneRevision: 0,
            personalRevision: read.scope.personalWatermark,
          },
    ...(pending ? { pending } : {}),
  });

  /** Takes a sky read into the held sky and marks the loaded systems that changed for a new read. */
  const admitSky = (outcome: Extract<SkyOutcome, { kind: 'map' | 'empty' }>) => {
    if (outcome.kind === 'empty') {
      forget(true);
      data = outcome.data;
      return;
    }
    const next = outcome.incremental ? new Map(sky) : new Map<string, SceneSkySystem>();
    const nextBytes = outcome.incremental ? new Map(skyBytes) : new Map<string, number>();
    for (const entry of outcome.entries) {
      const id = entry.descriptor.objectId;
      const previous = next.get(id);
      if (previous && previous.sceneRevision > entry.sceneRevision) fail('refresh_required');
      const size = bytes(entry);
      frozen(entry);
      next.set(id, entry);
      nextBytes.set(id, size);
    }
    let total = 0;
    for (const size of nextBytes.values()) total += size;
    if (total > UNIVERSE_SCENE_LIMITS.skyBytes) fail('limit');
    sky = next;
    skyBytes = nextBytes;
    skyList = undefined;
    data = outcome.data;
    for (const [id, system] of [...loaded]) {
      const entry = sky.get(id);
      if (!entry) {
        loaded.delete(id);
        stale.delete(id);
      } else if (entry.sceneRevision > system.readSceneRevision) {
        // The system changed after it was read. A change elsewhere in the map does not touch it.
        stale.add(id);
      }
    }
    invalidate();
  };

  // ---- One system ---------------------------------------------------------------------------------------------

  type Reach = { readonly kind: 'universe' } | { readonly kind: 'system'; readonly systemId: string };

  /**
   * The places of one system (`geography-read.v2`, routes with the system) or, for a map small enough to be read whole,
   * of the whole universe exactly as a client without the sky reads them: no version, routes on every page.
   */
  const readPlaces = async (selection: Reach, signal: AbortSignal, live: () => void): Promise<UniverseGeography> => {
    const one = selection.kind === 'system';
    const limits = one ? SYSTEM_LIMITS : WHOLE_MAP_LIMITS;
    let cursor: ReadGeography['cursor'];
    let header: GeographySnapshot | undefined;
    const objects: GeographyObject[] = [],
      routes = new Map<string, GeographyRoute>(),
      aliases = new Map<string, GeographyAlias>();
    let lastId = '';
    for (let page = 0; page < (one ? UNIVERSE_SCENE_LIMITS.systemPages : UNIVERSE_SCENE_LIMITS.pages); page++) {
      live();
      const raw = await abortable(signal, () =>
        scope.api.geography.read(
          {
            selection,
            limit: 100,
            ...(one ? { version: 'geography-read.v2' as const } : {}),
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        ),
      );
      live();
      checkEnvelopeScope(raw);
      const parsed = GeographySnapshotSchema.safeParse(raw);
      if (!parsed.success) fail();
      const read = parsed.data;
      checkScope(read.universeId, read.privacyEpoch);
      if (!equal(read.selection, selection)) fail();
      if (read.status === 'unavailable') fail(read.reason === 'snapshot_expired' ? 'refresh_required' : read.reason);
      // A system the sky named is established: empty or still loading is a disagreement, not a map.
      if (read.status === 'empty' || read.status === 'loading') fail('refresh_required');
      if (
        header &&
        (!equal(header.geography, read.geography) ||
          read.personalWatermark < header.personalWatermark ||
          header.status !== read.status)
      )
        fail('refresh_required');
      header = read;
      for (const o of read.page.objects) {
        if (o.id <= lastId) fail('refresh_required');
        lastId = o.id;
        objects.push(o);
      }
      const merge = <T extends { id: string }>(target: Map<string, T>, entries: readonly T[]) => {
        for (const entry of entries) {
          if (target.has(entry.id) && !equal(target.get(entry.id), entry)) fail('refresh_required');
          target.set(entry.id, entry);
        }
      };
      merge(routes, read.page.routes);
      merge(aliases, read.page.aliases);
      if (read.page.continuation.status === 'complete') {
        const candidate: UniverseGeography = {
          universeId: read.universeId,
          privacyEpoch: read.privacyEpoch,
          personalWatermark: read.personalWatermark,
          geography: read.geography,
          status: read.status,
          objects,
          routes: [...routes.values()],
          aliases: [...aliases.values()],
        };
        validateGeography(candidate, limits);
        if (one) {
          const roots = candidate.objects.filter((o) => o.kind === 'system');
          if (roots.length !== 1 || roots[0]!.id !== selection.systemId) fail();
        }
        return candidate;
      }
      cursor = read.page.continuation.cursor;
    }
    return fail('limit');
  };

  /** What a manifest read and its chunks gave: the same for a system and for a whole map. */
  interface SceneRead {
    readonly read: ManifestData;
    readonly chunks: readonly SceneChunk[];
    readonly looks: readonly SceneLook[];
    readonly readSceneRevision: number;
  }

  const readScene = async (
    selection: Reach,
    g: UniverseGeography,
    signal: AbortSignal,
    live: () => void,
  ): Promise<SceneRead> => {
    const query = { selection, capabilities };
    const limits = selection.kind === 'system' ? SYSTEM_LIMITS : WHOLE_MAP_LIMITS;
    const previous = selection.kind === 'system' ? loaded.get(selection.systemId) : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      live();
      const raw = await abortable(signal, () => scope.api.scenes.manifest(query, { signal }));
      live();
      checkEnvelopeScope(raw, true);
      const parsed = SceneManifestReadSchema.safeParse(raw);
      if (!parsed.success) fail();
      const read = parsed.data;
      checkScope(read.scope.universeId, read.scope.privacyEpoch);
      if (!equal(read.selection, selection) || !equal(read.capabilities, capabilities)) fail();
      if (!equal(read.currentGeography, g.geography) || read.scope.personalWatermark < g.personalWatermark)
        fail('refresh_required');
      if (
        (data && read.sceneRevision < data.sceneRevision) ||
        (previous && read.sceneRevision < previous.readSceneRevision)
      )
        fail('refresh_required');
      if (read.status === 'unsupported_version' || read.status === 'empty') fail();
      if (read.status === 'unavailable') fail(read.reason);
      if (read.status === 'loading') fail('temporarily_unavailable');
      const canonicalRead = { ...read, manifest: SceneManifestSchema.parse(read.manifest) };
      const chunks: SceneChunk[] = [];
      let at = 0;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let failure: unknown;
      const worker = async () => {
        while (at < canonicalRead.manifest.chunks.length && !controller.signal.aborted) {
          const ref = canonicalRead.manifest.chunks[at++]!;
          const reference = {
            universeId: read.scope.universeId,
            privacyEpoch: read.scope.privacyEpoch,
            manifestSceneRevision: read.sceneRevision,
            chunkId: ref.chunkId,
            chunkSceneRevision: ref.sceneRevision,
          };
          try {
            live();
            const rawChunk = await abortable(controller.signal, () =>
              scope.api.scenes.chunk({ ...query, reference }, { signal: controller.signal }),
            );
            live();
            if (controller.signal.aborted) return;
            checkEnvelopeScope(rawChunk, true);
            const parsedChunk = SceneChunkReadSchema.safeParse(rawChunk);
            if (!parsedChunk.success) fail();
            const reply = parsedChunk.data;
            checkScope(reply.scope.universeId, reply.scope.privacyEpoch);
            if (
              !equal(reply.selection, selection) ||
              !equal(reply.capabilities, capabilities) ||
              !equal(reply.reference, reference)
            )
              fail();
            if (reply.status === 'unavailable') {
              if (reply.reason === 'stale_manifest') throw new ReadFailure('stale_manifest');
              fail(reply.reason === 'unknown_chunk' ? 'invalid' : reply.reason);
            }
            if (reply.status !== 'ready') fail();
            if (
              !equal(reply.currentGeography, read.currentGeography) ||
              reply.scope.personalWatermark < read.scope.personalWatermark
            )
              fail('refresh_required');
            const chunk = SceneChunkSchema.parse(reply.chunk);
            const inputs = canonicalRead.manifest.revisions;
            if (
              chunk.revisions.geographyRevision > inputs.geographyRevision ||
              chunk.revisions.structureRevision > inputs.structureRevision ||
              chunk.revisions.activityRevision > inputs.activityRevision ||
              chunk.revisions.personalRevision > inputs.personalRevision
            )
              fail();
            if (
              chunk.objects.length !== ref.objectIds.length ||
              chunk.objects.some((o) => !ref.objectIds.includes(o.objectId))
            )
              fail();
            chunks.push(chunk);
          } catch (error) {
            if (failure === undefined) failure = error;
            controller.abort();
          }
        }
      };
      try {
        await Promise.all(
          Array.from(
            { length: Math.min(UNIVERSE_SCENE_LIMITS.concurrentChunks, canonicalRead.manifest.chunks.length) },
            worker,
          ),
        );
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      live();
      if (failure !== undefined) {
        if (failure instanceof ReadFailure && failure.reason === 'stale_manifest' && attempt === 0) continue;
        if (failure instanceof ReadFailure && failure.reason === 'stale_manifest') fail('refresh_required');
        throw failure instanceof Error ? failure : new ReadFailure('invalid');
      }
      chunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
      validateScene({ read: canonicalRead, chunks }, universeId, selection, g, limits);
      return {
        read: canonicalRead,
        chunks,
        looks: canonicalRead.looks ?? [],
        readSceneRevision: read.sceneRevision,
      };
    }
    return fail('refresh_required');
  };

  const loadSystem = async (systemId: string, signal: AbortSignal, live: () => void): Promise<LoadedSystem> => {
    const selection = { kind: 'system', systemId } as const;
    const g = await readPlaces(selection, signal, live);
    const scene = await readScene(selection, g, signal, live);
    return frozen({
      systemId,
      geography: g,
      chunks: scene.chunks,
      looks: scene.looks,
      readSceneRevision: scene.readSceneRevision,
      bytes: bytes(g) + bytes(scene.read) + bytes(scene.chunks),
    });
  };

  /**
   * Splits a whole-map read into the per-system records the session keeps, so `want`, unloading and refresh work as they do
   * for a map read one system at a time. `undefined` when the chunks do not fall cleanly on systems (the caller then reads
   * the systems one at a time).
   */
  const splitWhole = (g: UniverseGeography, scene: SceneRead): LoadedSystem[] | undefined => {
    const byId = new Map(g.objects.map((o) => [o.id, o]));
    const systemOfPlace = (placeId: string): string | undefined => {
      for (let o = byId.get(placeId); o; o = byId.get(o.parent.id)) if (o.kind === 'system') return o.id;
      return undefined;
    };
    const systemIds = g.objects.filter((o) => o.kind === 'system').map((o) => o.id);
    // The sky and the whole read must name the same systems; if they do not, the sky is behind.
    if (systemIds.length !== sky.size || systemIds.some((id) => !sky.has(id))) fail('refresh_required');
    const ownerOfChunk = new Map<SceneChunk, string>();
    for (const chunk of scene.chunks) {
      const owners = new Set<string | undefined>([
        ...chunk.objects.map((o) => systemOfPlace(o.objectId)),
        ...chunk.routes.map((r) => systemOfPlace(r.fromObjectId)),
      ]);
      const [owner] = [...owners];
      if (owners.size !== 1 || owner === undefined) return undefined;
      ownerOfChunk.set(chunk, owner);
    }
    return systemIds.sort().map((systemId) => {
      const objects = g.objects.filter((o) => systemOfPlace(o.id) === systemId);
      const own = new Set(objects.map((o) => o.id));
      const geography: UniverseGeography = {
        ...g,
        objects,
        routes: g.routes.filter((r) => systemOfPlace(r.fromObjectId) === systemId),
        aliases: g.aliases.filter((a) => systemOfPlace(a.fromObjectId) === systemId),
      };
      const chunks = scene.chunks.filter((chunk) => ownerOfChunk.get(chunk) === systemId);
      const looks = scene.looks.filter((look) => own.has(look.objectId));
      return frozen({
        systemId,
        geography,
        chunks,
        looks,
        readSceneRevision: scene.readSceneRevision,
        bytes: bytes(geography) + bytes(chunks) + bytes(looks),
      });
    });
  };

  /**
   * A map of at most `loadedSystems` systems is read as a client without the sky reads it: one geography read, one
   * manifest and its chunks four at a time, a single pass behind the sky read, so its first drawing costs what it always
   * cost. A few changed systems of a refresh are cheaper read one at a time, and a map that comes back `limit` (it
   * exceeds what the whole-map reads can hold) is read one system at a time too. Returns whether it loaded the map.
   */
  const loadWhole = async (signal: AbortSignal, live: () => void): Promise<boolean> => {
    if (!data || data.kind !== 'map' || sky.size === 0 || sky.size > eagerLimit) return false;
    const needed = [...sky.keys()].filter((id) => !loaded.has(id) || stale.has(id)).length;
    if (needed === 0) return false;
    if (loaded.size > 0 && 3 * needed <= sky.size + 2) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const g = await readPlaces({ kind: 'universe' }, signal, live);
        const scene = await readScene({ kind: 'universe' }, g, signal, live);
        const records = splitWhole(g, scene);
        if (!records) return false;
        if (records.reduce((sum, record) => sum + record.bytes, 0) > UNIVERSE_SCENE_LIMITS.retainedBytes) return false;
        for (const record of records) {
          loaded.set(record.systemId, record);
          if (sky.get(record.systemId)!.sceneRevision > record.readSceneRevision) stale.add(record.systemId);
          else stale.delete(record.systemId);
        }
        if (scene.readSceneRevision > data.sceneRevision || g.geography.revision > data.currentGeography.revision)
          refreshRequested = true;
        invalidate();
        return true;
      } catch (error) {
        if (error instanceof ReadFailure && error.reason === 'limit') return false;
        if (error instanceof ReadFailure && error.reason === 'refresh_required') {
          if (attempt === 0) continue;
          return false;
        }
        throw error;
      }
    }
    return false;
  };

  // ---- Which systems are loaded -------------------------------------------------------------------------------

  /** Lets go of the systems that are no longer wanted, oldest first, beyond the ones kept for a moment. */
  const enforceCap = (): boolean => {
    let changed = false;
    const keep = effectiveWanted();
    const unwanted = [...loaded.keys()]
      .filter((id) => !keep.has(id))
      .sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
    while (unwanted.length > UNIVERSE_SCENE_LIMITS.loadedSystems) {
      const id = unwanted.shift()!;
      loaded.delete(id);
      stale.delete(id);
      touched.delete(id);
      changed = true;
    }
    return changed;
  };
  const loadedBytes = (without?: string) =>
    [...loaded.values()].reduce((sum, system) => sum + (system.systemId === without ? 0 : system.bytes), 0);

  const admit = (system: LoadedSystem) => {
    if (!data || !sky.has(system.systemId)) return;
    let held = loadedBytes(system.systemId);
    if (held + system.bytes > UNIVERSE_SCENE_LIMITS.retainedBytes) {
      // Make room with the systems nobody wants, the oldest first.
      const keep = effectiveWanted();
      const evictable = [...loaded.keys()]
        .filter((id) => id !== system.systemId && !keep.has(id))
        .sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
      for (const id of evictable) {
        if (held + system.bytes <= UNIVERSE_SCENE_LIMITS.retainedBytes) break;
        held -= loaded.get(id)!.bytes;
        loaded.delete(id);
        stale.delete(id);
      }
      if (held + system.bytes > UNIVERSE_SCENE_LIMITS.retainedBytes) fail('limit');
    }
    loaded.set(system.systemId, system);
    const entry = sky.get(system.systemId)!;
    const g = system.geography.geography;
    // Changed since it was read: read it again. Newer than the sky we hold: read the sky again.
    if (entry.sceneRevision > system.readSceneRevision) stale.add(system.systemId);
    else stale.delete(system.systemId);
    if (system.readSceneRevision > data.sceneRevision || g.revision > data.currentGeography.revision)
      refreshRequested = true;
    enforceCap();
    invalidate();
  };

  const failAuthority = () => {
    stop();
    forget();
    notify({ status: 'unavailable', active, reason: 'authority' });
  };
  const requestRefresh = () => {
    if (!refreshRequested || running || autoRefreshedFor === runGeneration) return;
    refreshRequested = false;
    autoRefreshedFor = runGeneration;
    void observer?.refetch({ cancelRefetch: false });
  };

  const startLoad = (systemId: string) => {
    const controller = new AbortController();
    inFlight.set(systemId, controller);
    const lifecycle = loadGeneration;
    const live = () => {
      if (ended || !active || !scope.active || controller.signal.aborted || lifecycle !== loadGeneration)
        throw new ScopeEndedError();
    };
    void (async () => {
      try {
        const system = await loadSystem(systemId, controller.signal, live);
        live();
        admit(system);
        failures.delete(systemId);
      } catch (error) {
        if (ended || !active || !scope.active || controller.signal.aborted || lifecycle !== loadGeneration) return;
        const problem = error instanceof ORPCError ? apiProblem(error) : undefined;
        if (
          error instanceof ScopeEndedError ||
          (error instanceof ReadFailure && error.reason === 'authority') ||
          (error instanceof ORPCError && problem?.code !== 'NOT_FOUND' && AUTHORITY_STATUSES.includes(error.status))
        ) {
          failAuthority();
          return;
        }
        if (error instanceof ReadFailure && error.reason === 'refresh_required') refreshRequested = true;
        else
          failures.set(
            systemId,
            error instanceof ReadFailure && error.reason !== 'stale_manifest'
              ? error.reason
              : error instanceof TypeError || (error instanceof ORPCError && !problem)
                ? 'network'
                : 'invalid',
          );
      } finally {
        if (inFlight.get(systemId) === controller) inFlight.delete(systemId);
      }
      if (ended || !active) return;
      invalidate();
      if (!running) publishSettled();
      pump();
      requestRefresh();
      settleIdle();
    })();
  };

  /** Starts the loads the wanted systems need, a couple at a time. Nothing waits for the sky read in flight. */
  const pump = () => {
    if (!active || ended || !scope.active || running || !data || data.kind !== 'map') return;
    for (const id of effectiveWanted()) {
      if (inFlight.size >= UNIVERSE_SCENE_LIMITS.concurrentSystems) break;
      if (!sky.has(id) || inFlight.has(id) || failures.has(id) || (loaded.has(id) && !stale.has(id))) continue;
      startLoad(id);
    }
  };

  // ---- The run ------------------------------------------------------------------------------------------------

  const run = async (signal: AbortSignal): Promise<number> => {
    const mine = ++runGeneration;
    running = true;
    // This read is the refresh a load may have asked for.
    refreshRequested = false;
    const live = () => {
      if (ended || !active || !scope.active || signal.aborted || mine !== runGeneration) throw new ScopeEndedError();
    };
    try {
      live();
      publish('loading');
      let outcome: SkyOutcome;
      try {
        outcome = await readSky(signal, live, data?.kind === 'map' ? data.sceneRevision : undefined);
        if (outcome.kind === 'map') admitSky(outcome);
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.reason !== 'refresh_required') throw error;
        outcome = await readSky(signal, live, undefined);
        if (outcome.kind === 'map') admitSky(outcome);
      }
      live();
      if (outcome.kind === 'empty') admitSky(outcome);
      if (outcome.kind === 'map') await loadWhole(signal, live);
      live();
      failures.clear();
      enforceCap();
      invalidate();
      switch (outcome.kind) {
        case 'unsupported':
          forget();
          notify({ status: 'unsupported', active });
          break;
        case 'unavailable':
          publish('unavailable', { reason: outcome.reason });
          break;
        case 'loading':
          publish('loading', { pendingProjection: outcome.pending });
          break;
        case 'empty':
        case 'map':
          publishSettled();
      }
    } catch (error) {
      if (ended || !active || !scope.active || signal.aborted || mine !== runGeneration) return mine;
      const authority =
        error instanceof ScopeEndedError ||
        (error instanceof ReadFailure && error.reason === 'authority') ||
        (error instanceof ORPCError && AUTHORITY_STATUSES.includes(error.status));
      if (authority) {
        forget();
        publish('unavailable', { reason: 'authority' });
      } else
        publish('unavailable', {
          reason:
            error instanceof ReadFailure && error.reason !== 'stale_manifest'
              ? error.reason
              : error instanceof TypeError || error instanceof ORPCError
                ? 'network'
                : 'invalid',
        });
    } finally {
      if (mine === runGeneration) running = false;
    }
    if (mine === runGeneration && !ended && active) {
      pump();
      requestRefresh();
      settleIdle();
    }
    return mine;
  };

  const start = () => {
    if (ended || !scope.active || active) return;
    active = true;
    observer = new QueryObserver<number>(scope.queryClient, {
      queryKey: [...queryPrefix, JSON.stringify({ kind: 'universe' }), JSON.stringify(capabilities)],
      queryFn: ({ signal }) => run(signal),
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    observer.subscribe(() => {
      /* Observer keeps existing scope invalidations live; run owns state. */
    });
  };
  if (!scope.active || typeof scope.onEnd !== 'function') {
    ended = true;
    state = frozen({ status: 'unavailable', active: false, reason: 'scope_unavailable' });
  } else unsubscribeEnd = scope.onEnd(dispose);

  return {
    getState: () => state,
    subscribe(listener) {
      if (ended) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    resume: start,
    pause() {
      if (ended) return;
      active = false;
      stop();
      notify({ ...state, active });
    },
    // The sky is the whole map: a system is reached through `want`.
    select() {},
    want(systemIds) {
      if (ended) return;
      const next = new Set<string>();
      for (const id of systemIds) {
        if (typeof id !== 'string') continue;
        next.add(id);
        touched.set(id, ++tick);
        // Asking for a system again is a new reason to try it.
        if (!wanted.has(id)) failures.delete(id);
      }
      wanted = next;
      const dropped = enforceCap();
      if (dropped) {
        invalidate();
        if (!running && data) publishSettled();
      }
      pump();
    },
    async refresh() {
      if (ended || !active || !scope.active) return;
      await observer?.refetch({ cancelRefetch: true });
      await whenIdle();
    },
    dispose,
  };
}
