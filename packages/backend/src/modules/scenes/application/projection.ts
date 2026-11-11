import {
  SceneDescriptorSchema,
  SceneChunkSchema,
  SCENE_LIMITS,
  type SceneChunk,
  type SceneDescriptor,
  type SceneRevisions,
} from '@knowscroll/contracts';
import { CONCEPTS, sceneFamilyOf } from '../../content/public.js';
import type { GeographySceneInput } from '../../geography/public.js';
import { cellAnchor, FINE_SPACING, LAYOUT_V2, nextSystemCell, planetOffset } from '../domain/layout.js';
import type { SceneLayoutState, StoredChunk, StoredObject, SystemRow } from './ports.js';

/**
 * The namespace identity derivations hash under: an object's seed and a chunk's id. It is the name the world's first
 * layout carried and it never changes, so a system that was laid out by `canonical-lattice.v1` keeps the chunks and
 * seeds it has and a new planet of it lands in the same buckets (D-417). It is not the layout of a new object.
 */
export const SCENE_POLICY = 'canonical-lattice.v1';
export class ProjectionUnavailable extends Error {
  constructor(readonly reason: 'limit' | 'temporarily_unavailable') {
    super('SCENE_PROJECTION_UNAVAILABLE');
  }
}
const refuse = (reason: 'limit' | 'temporarily_unavailable'): never => {
  throw new ProjectionUnavailable(reason);
};
const rank = { system: 0, star: 1, planet: 2, region: 3 };
type Place = GeographySceneInput['objects'][number];
/**
 * The family of one object, from the library plan's catalogue. Only canonical meaning IDs of the
 * right kind are accepted: a system or star must be a catalogue system, a planet must be a planet of
 * its parent system, and a region must be a facet of its planet and inherits that planet's family.
 * Anything else fails closed; nothing is guessed from a label or a hash.
 */
function family(
  o: Place,
  parent: StoredObject | undefined,
  parentMeaningId: string | undefined,
): SceneDescriptor['family'] {
  const concept = CONCEPTS.find((candidate) => candidate.id === o.meaningId);
  if (o.kind === 'region') {
    const planet = CONCEPTS.find((candidate) => candidate.id === parentMeaningId);
    if (
      !parent ||
      planet === undefined ||
      planet.parent === null ||
      !planet.facets.some((facet) => facet.id === o.meaningId)
    )
      return refuse('temporarily_unavailable');
    return parent.descriptor.family;
  }
  const isSystem = o.kind === 'system' || o.kind === 'star';
  if (!concept || (isSystem ? concept.parent !== null : concept.parent !== parentMeaningId))
    return refuse('temporarily_unavailable');
  return sceneFamilyOf(o.meaningId) ?? refuse('temporarily_unavailable');
}
/** UUID derived from opaque seed + stable chunk identity; contains no account or meaning text. */
function chunkId(hash: (v: unknown) => string, worldSeed: string, systemId: string, bucket: string): string {
  const h = hash([SCENE_POLICY, worldSeed, systemId, bucket]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One system after a projection. */
export interface SystemProjection {
  readonly systemId: string;
  readonly isNew: boolean;
  /** Every stored object of the system after the projection. */
  readonly objects: readonly StoredObject[];
  /** The ones to write: new, or with a new label or activity. */
  readonly upserts: readonly StoredObject[];
  /** Only the chunks whose content changed; an unchanged chunk keeps its version. */
  readonly changed: readonly StoredChunk[];
  readonly cell: number | null;
  readonly planetCount: number;
  readonly objectCount: number;
  /** Something of the system changed: an object arrived, a label or activity changed, or a chunk has a new version. */
  readonly touched: boolean;
}
export interface SystemsInput {
  /** Geography's places and routes of exactly `systemIds`. */
  readonly input: GeographySceneInput;
  /** The systems to project, in the order they are laid out (id order). */
  readonly systemIds: readonly string[];
  /** The stored objects and current chunks of those systems, and their sky rows. */
  readonly stored: readonly StoredObject[];
  readonly chunks: readonly StoredChunk[];
  readonly rows: ReadonlyMap<string, SystemRow>;
  readonly layout: SceneLayoutState;
  readonly worldSeed: string;
  readonly revisions: SceneRevisions;
  readonly hash: (v: unknown) => string;
}

const equalActivity = (a: SceneDescriptor['activity'], b: SceneDescriptor['activity']) =>
  JSON.stringify(a) === JSON.stringify(b);
const offsetKey = (dx: number, dy: number) => `${dx},${dy}`;

/**
 * Projects some systems of a map (D-417): the same checks and identity derivations as ever, for those systems alone.
 * A stored object keeps its descriptor but for its label and activity; a new object takes its place from
 * `canonical-lattice.v2` (`domain/layout.ts`): a system the next free coarse cell, its star the system's anchor, a
 * planet the next free ordinal around its star, a region its planet's anchor. Chunks are assigned to buckets of 100
 * objects and of 100 routes as before, and only a chunk whose content changed gets a new version. Pure: it reads
 * nothing and writes nothing, and a refusal (`ProjectionUnavailable`, or a canonical parser error) leaves nothing.
 */
export function projectSystems(args: SystemsInput): {
  readonly systems: readonly SystemProjection[];
  readonly layout: SceneLayoutState;
} {
  const { input, hash, worldSeed, revisions } = args;
  const byId = new Map(input.objects.map((o) => [o.id, o]));
  if (byId.size !== input.objects.length) return refuse('temporarily_unavailable');
  const systemOf = (o: Place): string | undefined => {
    if (o.kind === 'system') return o.id;
    if (o.kind !== 'region') return o.parent.id;
    const planet = byId.get(o.parent.id);
    return planet?.kind === 'planet' ? planet.parent.id : undefined;
  };
  const groups = new Map<string, Place[]>();
  for (const o of input.objects) {
    const system = systemOf(o);
    if (system === undefined || !args.systemIds.includes(system)) return refuse('temporarily_unavailable');
    groups.set(system, [...(groups.get(system) ?? []), o]);
  }
  const storedBy = new Map<string, StoredObject[]>();
  for (const o of args.stored) storedBy.set(o.systemId, [...(storedBy.get(o.systemId) ?? []), o]);
  const chunksBy = new Map<string, StoredChunk[]>();
  for (const c of args.chunks) chunksBy.set(c.systemId, [...(chunksBy.get(c.systemId) ?? []), c]);

  let layout = args.layout;
  const systems: SystemProjection[] = [];
  for (const systemId of args.systemIds) {
    const places = groups.get(systemId);
    if (!places?.some((o) => o.id === systemId && o.kind === 'system')) return refuse('temporarily_unavailable');
    const stored = storedBy.get(systemId) ?? [];
    // A place never disappears: everything stored must still be in Geography's answer.
    if (stored.some((o) => !byId.has(o.descriptor.objectId))) return refuse('temporarily_unavailable');
    const projected = projectOne(systemId, places, stored, chunksBy.get(systemId) ?? [], layout);
    layout = projected.layout;
    systems.push(projected.system);
  }
  return { systems, layout };

  function projectOne(
    systemId: string,
    places: readonly Place[],
    stored: readonly StoredObject[],
    priorChunks: readonly StoredChunk[],
    layoutIn: SceneLayoutState,
  ): { system: SystemProjection; layout: SceneLayoutState } {
    let layoutOut = layoutIn;
    const objects = new Map(stored.map((o) => [o.descriptor.objectId, o]));
    if (objects.size !== stored.length) return refuse('temporarily_unavailable');
    const upserts = new Map<string, StoredObject>();
    const isNew = !objects.has(systemId);
    let cell = args.rows.get(systemId)?.cell ?? null;
    let count = stored.length;
    const ordinals = new Set(
      stored.filter((o) => o.layout === LAYOUT_V2 && o.descriptor.kind === 'planet').map((o) => o.slot!),
    );
    let occupied: Set<string> | undefined;

    /** Where a new object goes, from `canonical-lattice.v2` and what the system already holds. */
    const layOut = (
      o: Place,
      parent: StoredObject | undefined,
    ): { anchor: { x: number; y: number }; slot: number | null } => {
      if (o.kind === 'system') {
        cell = nextSystemCell(layoutOut.nextCell, layoutOut.legacyReach);
        layoutOut = { ...layoutOut, nextCell: cell + 1 };
        return { anchor: cellAnchor(cell), slot: null };
      }
      const home = objects.get(systemId)!.descriptor.anchor;
      if (o.kind === 'star') return { anchor: { x: home.x, y: home.y }, slot: null };
      if (o.kind === 'region')
        return { anchor: { x: parent!.descriptor.anchor.x, y: parent!.descriptor.anchor.y }, slot: null };
      // A planet orbits its star: the system's own anchor in a v2 system, its star's where the older layout put one.
      const star = [...objects.values()].find((s) => s.descriptor.kind === 'star');
      const origin = (star ?? objects.get(systemId)!).descriptor.anchor;
      if (occupied === undefined) {
        occupied = new Set(
          [...objects.values()]
            .filter((s) => s.descriptor.kind === 'planet')
            .map((s) =>
              offsetKey(
                Math.round((s.descriptor.anchor.x - origin.x) / FINE_SPACING),
                Math.round((s.descriptor.anchor.y - origin.y) / FINE_SPACING),
              ),
            ),
        );
      }
      // The smallest ordinal no planet of the system has, whose place no older planet already holds around the star.
      let ordinal = 0;
      for (;;) {
        const offset = planetOffset(ordinal);
        if (!ordinals.has(ordinal) && !occupied.has(offsetKey(offset.x / FINE_SPACING, offset.y / FINE_SPACING))) break;
        ordinal++;
      }
      const offset = planetOffset(ordinal);
      ordinals.add(ordinal);
      occupied.add(offsetKey(offset.x / FINE_SPACING, offset.y / FINE_SPACING));
      return { anchor: { x: origin.x + offset.x, y: origin.y + offset.y }, slot: ordinal };
    };

    for (const o of [...places].sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id))) {
      const parent = objects.get(o.parent.id);
      if (
        o.kind === 'system'
          ? o.parent.kind !== 'universe' || o.parent.id !== input.universeId
          : !parent ||
            parent.descriptor.kind !== (o.kind === 'region' ? 'planet' : 'system') ||
            parent.descriptor.truthStatus !== o.truthStatus
      )
        return refuse('temporarily_unavailable');
      const chosenFamily = family(o, parent, byId.get(o.parent.id)?.meaningId),
        existing = objects.get(o.id);
      if (existing) {
        const d = existing.descriptor;
        if (
          d.parentId !== o.parent.id ||
          d.kind !== o.kind ||
          d.truthStatus !== o.truthStatus ||
          d.originTransitionId !== o.originTransitionId ||
          d.family !== chosenFamily
        )
          return refuse('temporarily_unavailable');
        if (d.label !== o.label || !equalActivity(d.activity, o.activity)) {
          const next = {
            ...existing,
            descriptor: SceneDescriptorSchema.parse({ ...d, label: o.label, activity: o.activity }),
          };
          objects.set(o.id, next);
          upserts.set(o.id, next);
        }
        continue;
      }
      const place = layOut(o, parent);
      const descriptor = SceneDescriptorSchema.parse({
        schemaVersion: 'scene-descriptor.v1',
        generatorVersion: 'silhouette.v1',
        objectId: o.id,
        parentId: o.parent.id,
        kind: o.kind,
        originTransitionId: o.originTransitionId,
        label: o.label,
        truthStatus: o.truthStatus,
        activity: o.activity,
        family: chosenFamily,
        seed: hash([SCENE_POLICY, worldSeed, o.id]).slice(0, 32),
        palette: chosenFamily === 'terraced.v1' ? 'ochre' : chosenFamily === 'ridged.v1' ? 'sage' : 'cobalt',
        material: 'solid',
        atmosphere: { density: 0.15 },
        detail: { roughness: 0.4 },
        anchor: { ...place.anchor, layer: rank[o.kind] },
        target: { kind: o.kind, objectId: o.id },
      });
      const created: StoredObject = {
        descriptor,
        systemId,
        chunkId: chunkId(hash, worldSeed, systemId, `objects:${Math.floor(count / SCENE_LIMITS.objectsPerChunk)}`),
        slot: place.slot,
        layout: LAYOUT_V2,
      };
      count++;
      objects.set(o.id, created);
      upserts.set(o.id, created);
    }

    // Routes: those whose first end is a planet of this system.
    const routes = input.routes.filter((r) => objects.has(r.fromObjectId));
    const retained = new Map<string, string>();
    for (const c of priorChunks) for (const r of c.chunk.routes) retained.set(r.id, c.chunk.chunkId);
    if (
      retained.size !== priorChunks.reduce((n, c) => n + c.chunk.routes.length, 0) ||
      [...retained.keys()].some((id) => !routes.some((current) => current.id === id))
    )
      return refuse('temporarily_unavailable');
    const routeIds = new Set<string>();
    for (const r of routes) {
      const a = objects.get(r.fromObjectId),
        b = objects.get(r.toObjectId);
      if (
        !a ||
        !b ||
        a.descriptor.kind !== 'planet' ||
        b.descriptor.kind !== 'planet' ||
        a.descriptor.parentId !== b.descriptor.parentId ||
        a.descriptor.truthStatus !== r.truthStatus ||
        b.descriptor.truthStatus !== r.truthStatus ||
        a.descriptor.objectId === b.descriptor.objectId ||
        routeIds.has(r.id) ||
        objects.has(r.id)
      )
        return refuse('temporarily_unavailable');
      routeIds.add(r.id);
    }

    const buckets = new Map<string, { objects: SceneDescriptor[]; routes: SceneChunk['routes'] }>();
    const bucket = (id: string) => {
      const b = buckets.get(id) ?? { objects: [], routes: [] };
      buckets.set(id, b);
      return b;
    };
    for (const o of objects.values()) bucket(o.chunkId).objects.push(o.descriptor);
    const asRoute = (r: (typeof routes)[number]): SceneChunk['routes'][number] => ({
      id: r.id,
      fromObjectId: r.fromObjectId,
      toObjectId: r.toObjectId,
      originTransitionId: r.originTransitionId,
      truthStatus: r.truthStatus,
    });
    const current = routes.filter((r) => r.status === 'current').sort((a, b) => a.id.localeCompare(b.id));
    // A route keeps the chunk it arrived in; a withdrawn one leaves it. A new route takes the first route chunk with room.
    for (const r of current) if (retained.has(r.id)) bucket(retained.get(r.id)!).routes.push(asRoute(r));
    for (const r of current) {
      if (retained.has(r.id)) continue;
      let index = 0;
      let id = chunkId(hash, worldSeed, systemId, 'routes:0');
      while ((buckets.get(id)?.routes.length ?? 0) >= SCENE_LIMITS.routesPerChunk) {
        if (++index >= SCENE_LIMITS.chunksPerManifest) return refuse('limit');
        id = chunkId(hash, worldSeed, systemId, `routes:${index}`);
      }
      bucket(id).routes.push(asRoute(r));
    }
    if (buckets.size > SCENE_LIMITS.chunksPerManifest) return refuse('limit');

    const changed: StoredChunk[] = [];
    const prior = new Map(priorChunks.map((c) => [c.chunk.chunkId, c.chunk]));
    for (const [id, b] of [...buckets].sort(([a], [c]) => a.localeCompare(c))) {
      b.objects.sort((a, c) => a.objectId.localeCompare(c.objectId));
      b.routes.sort((a, c) => a.id.localeCompare(c.id));
      const old = prior.get(id);
      if (old && hash([old.objects, old.routes]) === hash([b.objects, b.routes])) continue;
      changed.push({
        systemId,
        chunk: SceneChunkSchema.parse({
          schemaVersion: 'scene-chunk.v1',
          chunkId: id,
          revisions,
          objects: b.objects,
          routes: b.routes,
        }),
      });
    }
    // A route chunk whose routes were all withdrawn is replaced by an empty version, which no manifest names.
    for (const [id, old] of prior)
      if (!buckets.has(id) && old.objects.length + old.routes.length > 0)
        changed.push({
          systemId,
          chunk: SceneChunkSchema.parse({
            schemaVersion: 'scene-chunk.v1',
            chunkId: id,
            revisions,
            objects: [],
            routes: [],
          }),
        });

    const all = [...objects.values()];
    return {
      layout: layoutOut,
      system: {
        systemId,
        isNew,
        objects: all,
        upserts: [...upserts.values()],
        changed,
        cell,
        planetCount: all.filter((o) => o.descriptor.kind === 'planet').length,
        objectCount: all.length,
        touched: upserts.size > 0 || changed.length > 0,
      },
    };
  }
}
