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
import type { GeographySceneInput } from '../../geography/public.js';
import type { StoredObject, StoredChunk } from './ports.js';
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
/** Canonical meaning IDs only; regions inherit an admitted canonical parent's family. */
function family(o: GeographySceneInput['objects'][number], parent?: StoredObject): SceneDescriptor['family'] {
  if (o.kind === 'system' || o.kind === 'star')
    return o.meaningId === 'earth' ? 'terraced.v1' : refuse('temporarily_unavailable');
  if (o.kind === 'region') {
    const facets: Record<string, readonly string[]> = {
      'terraced.v1': ['earth.seasons.axial-tilt', 'earth.seasons.hemispheres', 'earth.seasons.limits'],
      'archipelago.v1': ['earth.tides.forcing', 'earth.tides.alignment', 'earth.tides.coasts'],
      'ridged.v1': [
        'earth.greenhouse-effect.radiation',
        'earth.greenhouse-effect.balance',
        'earth.greenhouse-effect.limits',
      ],
    };
    if (!parent || !facets[parent.descriptor.family]!.includes(o.meaningId)) return refuse('temporarily_unavailable');
    return parent.descriptor.family;
  }
  const families: Record<string, SceneDescriptor['family']> = {
    'earth.seasons': 'terraced.v1',
    'earth.tides': 'archipelago.v1',
    'earth.greenhouse-effect': 'ridged.v1',
  };
  return families[o.meaningId] ?? refuse('temporarily_unavailable');
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
): {
  readonly manifest: SceneManifest;
  readonly objects: readonly StoredObject[];
  readonly changed: readonly StoredChunk[];
} {
  if (input.objects.length > 1000 || input.routes.length + input.aliases.length > 1000) return refuse('limit');
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
    const chosenFamily = family(o, parent),
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
  const routeCounts = new Map<string, number>();
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
    if (r.status !== 'current') continue;
    const index = routeCounts.get(a.systemId) ?? 0;
    routeCounts.set(a.systemId, index + 1);
    const id = chunkId(hash, worldSeed, a.systemId, `routes:${Math.floor(index / SCENE_LIMITS.routesPerChunk)}`),
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
  return { manifest, objects: [...objects.values()], changed };
}
