import { QueryObserver } from '@tanstack/react-query';
import { ORPCError } from '@orpc/client';
import {
  GeographySnapshotSchema,
  UniverseDeltasSchema,
  ReadSceneManifestSchema,
  SceneManifestReadSchema,
  SceneChunkReadSchema,
  SceneManifestSchema,
  SceneChunkSchema,
  type GeographyObject,
  type GeographyRoute,
  type GeographyAlias,
  type GeographyRevisions,
  type GeographySnapshot,
  type ReadGeography,
  type ReadSceneManifest,
  type SceneClientCapabilities,
  type SceneChunk,
  type SceneDescriptor,
  type SceneManifestRead,
  type UniverseDelta,
} from '@knowscroll/contracts';
import { ScopeEndedError, type AccountScope } from './account-scope';

/** Accepted-data budgets, not a bound on the generic HTTP client's pre-decode allocation. */
export const UNIVERSE_SCENE_LIMITS = {
  pages: 10,
  objects: 1000,
  relations: 1000,
  chunks: 128,
  concurrentChunks: 4,
  catchupBatches: 4,
  retainedBytes: 8 * 1024 * 1024,
} as const;

type Selection = ReadSceneManifest['selection'];
type ManifestData = Extract<SceneManifestRead, { status: 'ready' | 'empty' | 'lagging' }>;
export interface UniverseGeography {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly personalWatermark: number;
  readonly geography: GeographyRevisions;
  readonly status: 'empty' | 'loading' | 'ready' | 'lagging';
  readonly objects: readonly GeographyObject[];
  readonly routes: readonly GeographyRoute[];
  readonly aliases: readonly GeographyAlias[];
}
export interface UniverseSceneSnapshot {
  readonly read: ManifestData;
  readonly chunks: readonly SceneChunk[];
}
export type UniverseSceneReason =
  'scope_unavailable' | 'authority' | 'network' | 'invalid' | 'limit' | 'refresh_required' | 'temporarily_unavailable';
export interface UniverseSceneState {
  readonly status: 'idle' | 'loading' | 'empty' | 'ready' | 'lagging' | 'unsupported' | 'unavailable' | 'ended';
  readonly active: boolean;
  /** A complete global Geography, independent of the last Scene's projection-input stamps. */
  readonly geography?: UniverseGeography;
  /** Last complete same-selection Scene; unavailable/loading never relabels it current. */
  readonly snapshot?: UniverseSceneSnapshot;
  readonly reason?: UniverseSceneReason;
  readonly pendingProjection?: { readonly geographyRevision: number; readonly personalRevision: number };
}
export interface UniverseSceneSession {
  readonly getState: () => UniverseSceneState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly select: (selection: Selection) => void;
  readonly refresh: () => Promise<void>;
  readonly dispose: () => void;
}

class ReadFailure extends Error {
  constructor(readonly reason: UniverseSceneReason | 'stale_manifest') {
    super('Universe view is unavailable.');
  }
}
function fail(reason: UniverseSceneReason = 'invalid'): never {
  throw new ReadFailure(reason);
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Structural consistency only; the server alone owns meaning, alias resolution and permission. */
function validateGeography(g: UniverseGeography): void {
  if (g.objects.length > UNIVERSE_SCENE_LIMITS.objects || g.routes.length + g.aliases.length > 1000) fail('limit');
  const objects = new Map(g.objects.map((o) => [o.id, o]));
  const ids = new Set([...g.objects, ...g.routes, ...g.aliases].map((v) => v.id));
  if (ids.size !== g.objects.length + g.routes.length + g.aliases.length) fail();
  for (const o of g.objects) {
    if (o.objectRevision > g.geography.revision) fail();
    if (o.kind === 'system') {
      if (o.parent.id !== g.universeId) fail();
    } else {
      const parent = objects.get(o.parent.id);
      if (
        !parent ||
        parent.kind !== (o.kind === 'region' ? 'planet' : 'system') ||
        parent.truthStatus !== o.truthStatus
      )
        fail();
    }
  }
  for (const r of g.routes) {
    const a = objects.get(r.fromObjectId),
      b = objects.get(r.toObjectId);
    if (
      !a ||
      !b ||
      a.kind !== 'planet' ||
      b.kind !== 'planet' ||
      a.parent.id !== b.parent.id ||
      a.truthStatus !== r.truthStatus ||
      b.truthStatus !== r.truthStatus ||
      r.relationRevision > g.geography.revision
    )
      fail();
  }
  const current = new Map<string, GeographyAlias>();
  for (const a of g.aliases) {
    const from = objects.get(a.fromObjectId),
      to = objects.get(a.toObjectId);
    if (
      !from ||
      !to ||
      from.kind !== to.kind ||
      from.truthStatus !== to.truthStatus ||
      a.relationRevision > g.geography.revision
    )
      fail();
    if (a.status === 'current') {
      if (current.has(a.fromObjectId)) fail();
      current.set(a.fromObjectId, a);
    }
  }
  for (const start of current.keys()) {
    const seen = new Set<string>();
    let id = start;
    while (current.has(id)) {
      if (seen.has(id)) fail();
      seen.add(id);
      id = current.get(id)!.toObjectId;
    }
  }
}

function applyDelta(g: UniverseGeography, delta: UniverseDelta): UniverseGeography {
  if (!equal(delta.base, g.geography) || delta.personalWatermark < g.personalWatermark) fail('refresh_required');
  const objects = new Map(g.objects.map((o) => [o.id, o]));
  const routes = new Map(g.routes.map((r) => [r.id, r]));
  const aliases = new Map(g.aliases.map((a) => [a.id, a]));
  const occupied = (id: string) => objects.has(id) || routes.has(id) || aliases.has(id);
  for (const op of delta.operations) {
    switch (op.kind) {
      case 'create_system':
      case 'establish_star':
      case 'form_planet':
      case 'add_region':
        if (occupied(op.object.id)) fail('refresh_required');
        objects.set(op.object.id, op.object);
        break;
      case 'connect_route':
        if (occupied(op.route.id)) fail('refresh_required');
        routes.set(op.route.id, op.route);
        break;
      case 'revise_label':
      case 'set_activity': {
        const previous = objects.get(op.objectId);
        if (!previous) fail('refresh_required');
        objects.set(op.objectId, {
          ...previous,
          objectRevision: op.objectRevision,
          ...(op.kind === 'revise_label' ? { label: op.label } : { activity: op.activity }),
        });
        break;
      }
      case 'withdraw_relation': {
        const route = routes.get(op.relationId),
          alias = aliases.get(op.relationId);
        if (route?.status === 'current')
          routes.set(route.id, { ...route, status: 'withdrawn', relationRevision: op.relationRevision });
        else if (alias?.status === 'current')
          aliases.set(alias.id, { ...alias, status: 'withdrawn', relationRevision: op.relationRevision });
        else fail('refresh_required');
      }
    }
  }
  const next = {
    ...g,
    personalWatermark: delta.personalWatermark,
    geography: delta.geography,
    status: objects.size ? ('ready' as const) : ('empty' as const),
    objects: [...objects.values()],
    routes: [...routes.values()],
    aliases: [...aliases.values()],
  };
  validateGeography(next);
  return next;
}

function validateScene(
  snapshot: UniverseSceneSnapshot,
  universeId: string,
  selection: Selection,
  geography: UniverseGeography,
): void {
  const descriptors: SceneDescriptor[] = snapshot.chunks.flatMap((c) => c.objects);
  const routes = snapshot.chunks.flatMap((c) => c.routes);
  if (descriptors.length > 1000 || routes.length > 1000) fail('limit');
  const objects = new Map(descriptors.map((o) => [o.objectId, o]));
  const ids = new Set([...objects.keys(), ...routes.map((r) => r.id)]);
  if (objects.size !== descriptors.length || ids.size !== descriptors.length + routes.length) fail();
  for (const o of descriptors) {
    if (o.kind === 'system') {
      if (o.parentId !== universeId || (selection.kind === 'system' && o.objectId !== selection.systemId)) fail();
    } else {
      const parent = objects.get(o.parentId);
      if (
        !parent ||
        parent.kind !== (o.kind === 'region' ? 'planet' : 'system') ||
        parent.truthStatus !== o.truthStatus
      )
        fail();
    }
  }
  if (selection.kind === 'system' && objects.get(selection.systemId)?.kind !== 'system') fail();
  const geoObjects = new Map(geography.objects.map((o) => [o.id, o]));
  const selected = geography.objects.filter(
    (o) =>
      selection.kind === 'universe' ||
      o.id === selection.systemId ||
      o.parent.id === selection.systemId ||
      geoObjects.get(o.parent.id)?.parent.id === selection.systemId,
  );
  const selectedIds = new Set(selected.map((o) => o.id));
  for (const o of descriptors) {
    const source = geoObjects.get(o.objectId);
    if (
      !source ||
      !selectedIds.has(o.objectId) ||
      source.kind !== o.kind ||
      source.parent.id !== o.parentId ||
      source.truthStatus !== o.truthStatus ||
      source.originTransitionId !== o.originTransitionId
    )
      fail();
    if (snapshot.read.status !== 'lagging' && (source.label !== o.label || !equal(source.activity, o.activity))) fail();
  }
  const selectedRoutes = geography.routes.filter(
    (r) => r.status === 'current' && selectedIds.has(r.fromObjectId) && selectedIds.has(r.toObjectId),
  );
  if (
    snapshot.read.status !== 'lagging' &&
    (selectedIds.size !== descriptors.length || selectedRoutes.length !== routes.length)
  )
    fail();
  for (const r of routes) {
    const source = geography.routes.find((v) => v.id === r.id);
    if (
      !source ||
      source.fromObjectId !== r.fromObjectId ||
      source.toObjectId !== r.toObjectId ||
      source.truthStatus !== r.truthStatus ||
      source.originTransitionId !== r.originTransitionId ||
      (snapshot.read.status !== 'lagging' && source.status !== 'current')
    )
      fail();
  }
  for (const r of routes) {
    const a = objects.get(r.fromObjectId),
      b = objects.get(r.toObjectId);
    if (
      !a ||
      !b ||
      a.kind !== 'planet' ||
      b.kind !== 'planet' ||
      a.parentId !== b.parentId ||
      a.truthStatus !== r.truthStatus ||
      b.truthStatus !== r.truthStatus
    )
      fail();
  }
}

/** Release our candidate continuation promptly even if the platform fetch ignores abort. */
function abortable<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(new ScopeEndedError());
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new ScopeEndedError();
        return task();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', cancel);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', cancel);
          reject(error instanceof Error ? error : new ReadFailure('invalid'));
        },
      );
  });
}

let nextSession = 0;
/**
 * A scope-object-owned readonly view. QueryObserver consumes existing socket invalidation; its
 * cache contains only a completion marker. Private values live here and are synchronously purged.
 * No timer, persistence, observation, queue, provider, raw fetch or client-derived appearance.
 */
export function createUniverseSceneSession(options: {
  readonly scope: AccountScope;
  readonly capabilities: SceneClientCapabilities;
  readonly selection?: Selection;
}): UniverseSceneSession {
  const { scope } = options;
  const queryPrefix = scope.queryKey('universe-scene', ++nextSession);
  const listeners = new Set<() => void>();
  let state: UniverseSceneState = frozen({ status: 'idle', active: false });
  let selection: Selection = { kind: 'universe' };
  let capabilities: SceneClientCapabilities | undefined;
  let geography: UniverseGeography | undefined;
  let snapshot: UniverseSceneSnapshot | undefined;
  let active = false,
    ended = false,
    generation = 0;
  let observer: QueryObserver<number> | undefined;
  let unsubscribeEnd: (() => void) | undefined;
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
  const stop = () => {
    generation++;
    observer?.destroy();
    observer = undefined;
    void scope.queryClient.cancelQueries({ queryKey: queryPrefix });
    scope.queryClient.removeQueries({ queryKey: queryPrefix });
  };
  const dispose = () => {
    if (ended) return;
    ended = true;
    active = false;
    stop();
    geography = undefined;
    snapshot = undefined;
    selection = { kind: 'universe' };
    capabilities = undefined;
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
    const data = (value: unknown, key: string): unknown => {
      if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
        return undefined;
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property && 'value' in property ? property.value : undefined;
    };
    const envelope = nested ? data(raw, 'scope') : raw;
    const universeId = data(envelope, 'universeId'),
      epoch = data(envelope, 'privacyEpoch');
    if (typeof universeId === 'string' && typeof epoch === 'number') checkScope(universeId, epoch);
  };
  const checkBudget = (g: UniverseGeography, data?: unknown) => {
    // Count both displayed and candidate canonical data, even when some references are shared.
    if (
      bytes(g) + bytes(data ?? null) + bytes(geography ?? null) + bytes(snapshot ?? null) >
      UNIVERSE_SCENE_LIMITS.retainedBytes
    )
      fail('limit');
  };
  const freshGeography = async (signal: AbortSignal, live: () => void): Promise<UniverseGeography> => {
    let cursor: ReadGeography['cursor'];
    let header: GeographySnapshot | undefined;
    const objects: GeographyObject[] = [],
      routes = new Map<string, GeographyRoute>(),
      aliases = new Map<string, GeographyAlias>();
    let lastId = '';
    for (let page = 0; page < UNIVERSE_SCENE_LIMITS.pages; page++) {
      live();
      const raw = await abortable(signal, () =>
        scope.api.geography.read(
          { selection: { kind: 'universe' }, limit: 100, ...(cursor ? { cursor } : {}) },
          { signal },
        ),
      );
      live();
      checkEnvelopeScope(raw);
      const parsed = GeographySnapshotSchema.safeParse(raw);
      if (!parsed.success) fail();
      const read = parsed.data;
      checkScope(read.universeId, read.privacyEpoch);
      if (!equal(read.selection, { kind: 'universe' })) fail();
      if (read.status === 'unavailable') fail(read.reason === 'snapshot_expired' ? 'refresh_required' : read.reason);
      if (
        header &&
        (!equal(header.geography, read.geography) ||
          read.personalWatermark < header.personalWatermark ||
          header.status !== read.status)
      )
        fail('refresh_required');
      header = read;
      if ('page' in read) {
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
      } else if (objects.length) fail('refresh_required');
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
      checkBudget(candidate);
      if (!('page' in read) || read.page.continuation.status === 'complete') {
        validateGeography(candidate);
        if (
          geography &&
          (candidate.geography.revision < geography.geography.revision ||
            candidate.geography.structureRevision < geography.geography.structureRevision ||
            candidate.geography.activityRevision < geography.geography.activityRevision ||
            candidate.personalWatermark < geography.personalWatermark)
        )
          fail('refresh_required');
        return candidate;
      }
      cursor = read.page.continuation.cursor;
    }
    return fail('limit');
  };
  const catchup = async (before: UniverseGeography, signal: AbortSignal, live: () => void) => {
    let next = before;
    const transitions = new Set<string>();
    for (let batch = 0; batch < UNIVERSE_SCENE_LIMITS.catchupBatches; batch++) {
      live();
      const raw = await abortable(signal, () =>
        scope.api.geography.deltas({ afterGeographyRevision: next.geography.revision, limit: 10 }, { signal }),
      );
      live();
      checkEnvelopeScope(raw);
      const parsed = UniverseDeltasSchema.safeParse(raw);
      if (!parsed.success) fail('refresh_required');
      const read = parsed.data;
      checkScope(read.universeId, read.privacyEpoch);
      if (
        read.status === 'snapshot_required' ||
        read.afterGeographyRevision !== next.geography.revision ||
        read.personalWatermark < next.personalWatermark
      )
        fail('refresh_required');
      for (const delta of read.deltas) {
        if (transitions.has(delta.transitionId)) fail('refresh_required');
        transitions.add(delta.transitionId);
        // Batch schemas constrain each delta; validate against the retained model as well.
        try {
          next = applyDelta(next, delta);
        } catch (error) {
          if (error instanceof ReadFailure && error.reason === 'limit') throw error;
          fail('refresh_required');
        }
      }
      next = { ...next, personalWatermark: read.personalWatermark };
      checkBudget(next);
      if (!read.hasMore) {
        if (!equal(next.geography, read.geography)) fail('refresh_required');
        return next;
      }
    }
    return fail('refresh_required');
  };
  const readScene = async (
    g: UniverseGeography,
    signal: AbortSignal,
    live: () => void,
  ): Promise<UniverseSceneState> => {
    if (!capabilities) return fail('scope_unavailable');
    const query = { selection, capabilities };
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
        snapshot &&
        (read.sceneRevision < snapshot.read.sceneRevision ||
          read.scope.personalWatermark < snapshot.read.scope.personalWatermark)
      )
        fail('refresh_required');
      if (read.status === 'unsupported_version') return { status: 'unsupported', active, geography: g };
      if (read.status === 'unavailable')
        return { status: 'unavailable', reason: read.reason, active, geography: g, snapshot };
      if (read.status === 'loading')
        return { status: 'loading', active, geography: g, snapshot, pendingProjection: read.pendingProjection };
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
            checkBudget(g, { read: canonicalRead, chunks });
          } catch (error) {
            if (failure === undefined) failure = error;
            controller.abort();
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(4, canonicalRead.manifest.chunks.length) }, worker));
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
      const next = { read: canonicalRead, chunks };
      validateScene(next, scope.account.universeId, selection, g);
      checkBudget(g, next);
      return {
        status: read.status,
        active,
        geography: g,
        snapshot: next,
        ...(read.status === 'lagging' ? { pendingProjection: read.pendingProjection } : {}),
      };
    }
    return fail('refresh_required');
  };
  const run = async (signal: AbortSignal): Promise<number> => {
    const mine = ++generation;
    const live = () => {
      if (ended || !active || !scope.active || signal.aborted || mine !== generation) throw new ScopeEndedError();
    };
    live();
    notify({ status: 'loading', active, geography, snapshot });
    try {
      let candidate: UniverseGeography;
      try {
        candidate = geography ? await catchup(geography, signal, live) : await freshGeography(signal, live);
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.reason !== 'refresh_required') throw error;
        candidate = await freshGeography(signal, live);
      }
      let next: UniverseSceneState;
      try {
        next = await readScene(candidate, signal, live);
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.reason !== 'refresh_required') throw error;
        candidate = await freshGeography(signal, live);
        next = await readScene(candidate, signal, live);
      }
      live();
      geography = frozen(candidate);
      snapshot = next.snapshot;
      notify(next);
    } catch (error) {
      if (ended || !active || !scope.active || signal.aborted || mine !== generation) return mine;
      const authority =
        error instanceof ScopeEndedError ||
        (error instanceof ReadFailure && error.reason === 'authority') ||
        (error instanceof ORPCError && [401, 403, 404, 409].includes(error.status));
      if (authority) {
        geography = undefined;
        snapshot = undefined;
      }
      notify({
        status: 'unavailable',
        active,
        geography,
        snapshot,
        reason: authority
          ? 'authority'
          : error instanceof ReadFailure && error.reason !== 'stale_manifest'
            ? error.reason
            : error instanceof TypeError || error instanceof ORPCError
              ? 'network'
              : 'invalid',
      });
    }
    return mine;
  };
  const start = () => {
    if (ended || !capabilities || !scope.active || active) return;
    active = true;
    observer = new QueryObserver<number>(scope.queryClient, {
      queryKey: [...queryPrefix, JSON.stringify(selection), JSON.stringify(capabilities)],
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
  try {
    const query = ReadSceneManifestSchema.parse({
      selection: options.selection ?? selection,
      capabilities: options.capabilities,
    });
    selection = frozen(query.selection);
    capabilities = frozen(query.capabilities);
    if (!scope.active || typeof scope.onEnd !== 'function') fail('scope_unavailable');
    unsubscribeEnd = scope.onEnd(dispose);
  } catch {
    ended = true;
    selection = { kind: 'universe' };
    capabilities = undefined;
    state = frozen({ status: 'unavailable', active: false, reason: 'scope_unavailable' });
  }
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
    select(next) {
      if (ended || !capabilities) return;
      const parsed = ReadSceneManifestSchema.safeParse({ selection: next, capabilities });
      if (!parsed.success) return;
      if (equal(parsed.data.selection, selection)) return;
      const restart = active;
      active = false;
      stop();
      selection = frozen(parsed.data.selection);
      snapshot = undefined;
      notify({ status: 'idle', active, geography });
      if (restart) start();
    },
    async refresh() {
      if (ended || !active || !scope.active) return;
      await observer?.refetch({ cancelRefetch: true });
    },
    dispose,
  };
}
