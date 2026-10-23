import {
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SCENE_LIMITS,
  type SceneDescriptor,
  type SceneRevisions,
  type SceneManifest,
  type SceneChunk,
} from '@knowscroll/contracts';
import { CONCEPTS, sceneFamilyOf } from '../../content/public.js';
import type { GeographySceneInput } from '../../geography/public.js';
import type { StoredObject, StoredChunk, RouteChunk } from './ports.js';
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
/**
 * The family of one object, from the library plan's catalogue. Only canonical meaning IDs of the
 * right kind are accepted: a system or star must be a catalogue system, a planet must be a planet of
 * its parent system, and a region must be a facet of its planet and inherits that planet's family.
 * Anything else fails closed; nothing is guessed from a label or a hash.
 */
function family(
  o: GeographySceneInput['objects'][number],
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
const point = (slot: number) => ({ x: ((slot % 32) - 15.5) * 300, y: (Math.floor(slot / 32) - 15.5) * 300 });
export function projectBounded(
  input: GeographySceneInput,
  prior: readonly StoredObject[],
  previousChunks: readonly StoredChunk[],
  worldSeed: string,
  sceneRevision: number,
  hash: (v: unknown) => string,
  priorRoutes?: readonly RouteChunk[],
): {
  readonly manifest: SceneManifest;
  readonly objects: readonly StoredObject[];
  readonly changed: readonly StoredChunk[];
  readonly routeChunks: readonly RouteChunk[];
} {
  if (input.objects.length > 1000 || prior.length > 1000 || input.routes.length + input.aliases.length > 1000)
    return refuse('limit');
  const ids = new Map(input.objects.map((o) => [o.id, o]));
  if (ids.size !== input.objects.length) return refuse('temporarily_unavailable');
  const objects = new Map(prior.map((o) => [o.descriptor.objectId, o])),
    occupied = new Set(prior.map((o) => o.slot));
  if (
    objects.size !== prior.length ||
    occupied.size !== prior.length ||
    prior.some((o) => !ids.has(o.descriptor.objectId) || o.slot < 0 || o.slot >= 1024)
  )
    return refuse('temporarily_unavailable');
  for (const o of [...input.objects].sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id))) {
    const parent = objects.get(o.parent.id);
    if (
      o.kind === 'system'
        ? o.parent.kind !== 'universe' || o.parent.id !== input.universeId
        : !parent ||
          parent.descriptor.kind !== (o.kind === 'region' ? 'planet' : 'system') ||
          parent.descriptor.truthStatus !== o.truthStatus
    )
      return refuse('temporarily_unavailable');
    const chosenFamily = family(o, parent, ids.get(o.parent.id)?.meaningId),
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
      objects.set(o.id, {
        ...existing,
        descriptor: SceneDescriptorSchema.parse({ ...d, label: o.label, activity: o.activity }),
      });
      continue;
    }
    const systemId = o.kind === 'system' ? o.id : parent!.systemId,
      center = parent?.descriptor.anchor ?? { x: 0, y: 0 };
    const candidates = Array.from({ length: 1024 }, (_, slot) => slot).filter((slot) => !occupied.has(slot));
    const tie = Number.parseInt(hash([worldSeed, o.id]).slice(0, 8), 16) % 1024;
    candidates.sort((a, b) => {
      const pa = point(a),
        pb = point(b);
      return (
        (pa.x - center.x) ** 2 + (pa.y - center.y) ** 2 - ((pb.x - center.x) ** 2 + (pb.y - center.y) ** 2) ||
        ((a + tie) % 1024) - ((b + tie) % 1024)
      );
    });
    const slot = candidates[0];
    if (slot === undefined) return refuse('limit');
    occupied.add(slot);
    const count = [...objects.values()].filter((x) => x.systemId === systemId).length;
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
      anchor: { ...point(slot), layer: rank[o.kind] },
      target: { kind: o.kind, objectId: o.id },
    });
    objects.set(o.id, {
      descriptor,
      systemId,
      chunkId: chunkId(hash, worldSeed, systemId, `objects:${Math.floor(count / SCENE_LIMITS.objectsPerChunk)}`),
      slot,
    });
  }
  const revisions: SceneRevisions = {
    geographyRevision: input.geography.revision,
    structureRevision: input.geography.structureRevision,
    activityRevision: input.geography.activityRevision,
    personalRevision: input.personalRevision,
    sceneRevision,
  };
  const buckets = new Map<string, { systemId: string; objects: SceneDescriptor[]; routes: SceneChunk['routes'] }>();
  for (const o of objects.values()) {
    const b = buckets.get(o.chunkId) ?? { systemId: o.systemId, objects: [], routes: [] };
    b.objects.push(o.descriptor);
    buckets.set(o.chunkId, b);
  }
  const retainedRoutes =
    priorRoutes ??
    previousChunks.flatMap((c) =>
      c.chunk.routes.map((r) => ({ routeId: r.id, systemId: c.systemId, chunkId: c.chunk.chunkId })),
    );
  const routeChunks = new Map(retainedRoutes.map((r) => [r.routeId, r]));
  if (
    routeChunks.size !== retainedRoutes.length ||
    retainedRoutes.length > 1000 ||
    retainedRoutes.some((r) => !input.routes.some((current) => current.id === r.routeId))
  )
    return refuse('temporarily_unavailable');
  const routeIds = new Set<string>();
  for (const r of [...input.routes].sort((a, b) => a.id.localeCompare(b.id))) {
    const a = objects.get(r.fromObjectId),
      b = objects.get(r.toObjectId);
    if (
      !a ||
      !b ||
      a.descriptor.kind !== 'planet' ||
      b.descriptor.kind !== 'planet' ||
      a.systemId !== b.systemId ||
      a.descriptor.parentId !== b.descriptor.parentId ||
      a.descriptor.truthStatus !== r.truthStatus ||
      b.descriptor.truthStatus !== r.truthStatus ||
      a.descriptor.objectId === b.descriptor.objectId
    )
      return refuse('temporarily_unavailable');
    if (routeIds.has(r.id) || objects.has(r.id)) return refuse('temporarily_unavailable');
    routeIds.add(r.id);
    let membership = routeChunks.get(r.id);
    if (membership && membership.systemId !== a.systemId) return refuse('temporarily_unavailable');
    if (!membership) {
      const index = [...routeChunks.values()].filter((r) => r.systemId === a.systemId).length;
      membership = {
        routeId: r.id,
        systemId: a.systemId,
        chunkId: chunkId(hash, worldSeed, a.systemId, `routes:${Math.floor(index / SCENE_LIMITS.routesPerChunk)}`),
      };
      routeChunks.set(r.id, membership);
    }
    if (r.status !== 'current') continue;
    const id = membership.chunkId,
      bucket = buckets.get(id) ?? { systemId: a.systemId, objects: [], routes: [] };
    bucket.routes.push({
      id: r.id,
      fromObjectId: r.fromObjectId,
      toObjectId: r.toObjectId,
      originTransitionId: r.originTransitionId,
      truthStatus: r.truthStatus,
    });
    buckets.set(id, bucket);
  }
  if (buckets.size > SCENE_LIMITS.chunksPerManifest) return refuse('limit');
  const changed: StoredChunk[] = [],
    references: SceneManifest['chunks'] = [];
  for (const [id, b] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    b.objects.sort((a, b) => a.objectId.localeCompare(b.objectId));
    const old = previousChunks.find((c) => c.chunk.chunkId === id),
      same = old && hash([old.chunk.objects, old.chunk.routes]) === hash([b.objects, b.routes]);
    const chunk = same
      ? old.chunk
      : SceneChunkSchema.parse({
          schemaVersion: 'scene-chunk.v1',
          chunkId: id,
          revisions,
          objects: b.objects,
          routes: b.routes,
        });
    if (!same) changed.push({ systemId: b.systemId, chunk });
    references.push({
      chunkId: id,
      sceneRevision: chunk.revisions.sceneRevision,
      objectIds: chunk.objects.map((o) => o.objectId),
    });
  }
  const manifest = SceneManifestSchema.parse({ schemaVersion: 'scene-manifest.v1', revisions, chunks: references });
  return { manifest, objects: [...objects.values()], changed, routeChunks: [...routeChunks.values()] };
}
