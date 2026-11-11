import type {
  GeographyObject,
  GeographyRoute,
  GeographyAlias,
  GeographyRevisions,
  ReadSceneManifest,
  SceneChunk,
  SceneDescriptor,
  SceneManifestRead,
  SceneSkySystem,
} from '@knowscroll/contracts';
import { ScopeEndedError } from './account-scope';

/**
 * Accepted-data budgets, not a bound on the generic HTTP client's pre-decode allocation. The first group holds the
 * whole map of a session that has no sky; the second is the sky session's (D-417): a map read as its sky first and one
 * system at a time.
 */
export const UNIVERSE_SCENE_LIMITS = {
  pages: 10,
  objects: 1000,
  relations: 1000,
  chunks: 128,
  concurrentChunks: 4,
  catchupBatches: 4,
  retainedBytes: 8 * 1024 * 1024,
  /** Systems a sky session holds besides the ones it was asked to want; a map of this many systems or fewer is loaded whole. */
  loadedSystems: 24,
  /** Systems loaded at the same time (each reads its chunks four at a time). */
  concurrentSystems: 4,
  /** Pages of the sky (200 systems each), so at most 120,000 systems. */
  skyPages: 600,
  /** Canonical bytes of the sky held at once. */
  skyBytes: 16 * 1024 * 1024,
  /** Pages of one system's geography read. */
  systemPages: 200,
} as const;

/** What one read of places may hold: the whole map for a session without the sky, one system for a sky session. */
export interface MapLimits {
  readonly objects: number;
  readonly relations: number;
}
export const WHOLE_MAP_LIMITS: MapLimits = {
  objects: UNIVERSE_SCENE_LIMITS.objects,
  relations: UNIVERSE_SCENE_LIMITS.relations,
};
/** One system holds at most what its manifest can name (128 chunks of 100 objects) and as many routes. */
export const SYSTEM_LIMITS: MapLimits = { objects: 12_800, relations: 12_800 };

export type Selection = ReadSceneManifest['selection'];
export type ManifestData = Extract<SceneManifestRead, { status: 'ready' | 'empty' | 'lagging' }>;
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
/** Every system of the map, from the sky read (D-417): what the far view draws and the label index lists. */
export interface UniverseSky {
  readonly systems: readonly SceneSkySystem[];
  /** The scene revision the sky was read at. */
  readonly sceneRevision: number;
}
export interface UniverseSceneState {
  readonly status: 'idle' | 'loading' | 'empty' | 'ready' | 'lagging' | 'unsupported' | 'unavailable' | 'ended';
  readonly active: boolean;
  /** A complete global Geography, independent of the last Scene's projection-input stamps. */
  readonly geography?: UniverseGeography;
  /** Last complete same-selection Scene; unavailable/loading never relabels it current. */
  readonly snapshot?: UniverseSceneSnapshot;
  readonly reason?: UniverseSceneReason;
  readonly pendingProjection?: { readonly geographyRevision: number; readonly personalRevision: number };
  /**
   * A sky session only (the client declared `scene-sky.v1`): every system of the map. `snapshot` and `geography` then
   * hold the loaded systems alone.
   */
  readonly sky?: UniverseSky;
  /** A sky session only: the systems whose planets are loaded now. */
  readonly loadedSystemIds?: readonly string[];
  /** A sky session only: systems that could not be loaded, so the map shows them without planets. */
  readonly failedSystemIds?: readonly string[];
}
export interface UniverseSceneSession {
  readonly getState: () => UniverseSceneState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly select: (selection: Selection) => void;
  /**
   * The systems whose planets, routes and regions should be loaded (D-417). A sky session loads them and lets go of
   * the systems that are no longer wanted; a session without the sky capability holds the whole map and ignores it.
   */
  readonly want: (systemIds: readonly string[]) => void;
  readonly refresh: () => Promise<void>;
  readonly dispose: () => void;
}

export class ReadFailure extends Error {
  constructor(readonly reason: UniverseSceneReason | 'stale_manifest') {
    super('Universe view is unavailable.');
  }
}
export function fail(reason: UniverseSceneReason = 'invalid'): never {
  throw new ReadFailure(reason);
}
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Structural consistency only; the server alone owns meaning, alias resolution and permission. */
export function validateGeography(g: UniverseGeography, limits: MapLimits = WHOLE_MAP_LIMITS): void {
  if (g.objects.length > limits.objects || g.routes.length + g.aliases.length > limits.relations) fail('limit');
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

export function validateScene(
  snapshot: UniverseSceneSnapshot,
  universeId: string,
  selection: Selection,
  geography: UniverseGeography,
  limits: MapLimits = WHOLE_MAP_LIMITS,
): void {
  const descriptors: SceneDescriptor[] = snapshot.chunks.flatMap((c) => c.objects);
  const routes = snapshot.chunks.flatMap((c) => c.routes);
  if (descriptors.length > limits.objects || routes.length > limits.relations) fail('limit');
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
export function abortable<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
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
