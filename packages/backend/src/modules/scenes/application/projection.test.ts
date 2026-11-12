import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SceneChunkSchema, SceneDescriptorSchema, SCENE_LIMITS } from '@knowscroll/contracts';
import { planSnapshot } from '../../content/public.js';
import type { GeographySceneInput } from '../../geography/public.js';
import { FINE_SPACING, LAYOUT_V1, LAYOUT_V2, SYSTEM_SPACING, cellAnchor, planetOffset } from '../domain/layout.js';
import { projectSystems, ProjectionUnavailable } from './projection.js';
import type { SceneLayoutState, StoredChunk, StoredObject, SystemRow } from './ports.js';

const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seed = 'a'.repeat(64);
function place(
  n: number,
  kind: 'system' | 'star' | 'planet' | 'region',
  parent: number,
  meaningId: string,
): GeographySceneInput['objects'][number] {
  return {
    id: id(n),
    kind,
    parent: { kind: kind === 'system' ? 'universe' : kind === 'region' ? 'planet' : 'system', id: id(parent) },
    meaningId,
    label: `Place ${n}`,
    objectRevision: 1,
    truthStatus: 'factual',
    activity: { availability: 'available', state: 'active' },
    originTransitionId: id(9999),
  } as GeographySceneInput['objects'][number];
}
function fixture(): GeographySceneInput {
  const objects = [
    place(2, 'system', 1, 'earth'),
    place(3, 'star', 2, 'earth'),
    place(4, 'planet', 2, 'earth.seasons'),
    place(5, 'region', 4, 'earth.seasons.axial-tilt'),
  ];
  return {
    universeId: id(1),
    privacyEpoch: 1,
    personalRevision: 71,
    geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
    objectCount: objects.length,
    objects,
    routes: [],
    aliases: [],
  };
}
type Result = ReturnType<typeof projectSystems>;
/** What Scenes has stored, updated the way the projector updates it: a projection applied on top of the last. */
class World {
  objects = new Map<string, StoredObject>();
  chunks = new Map<string, StoredChunk>();
  rows = new Map<string, SystemRow>();
  layout: SceneLayoutState = { legacyReach: 0, nextCell: 0 };
  revision = 0;
  project(input: GeographySceneInput, only?: readonly string[]): Result {
    const systemIds =
      only ??
      [...new Set(input.objects.filter((o) => o.kind === 'system').map((o) => o.id))].sort((a, b) =>
        a.localeCompare(b),
      );
    this.revision++;
    const result = projectSystems({
      input,
      systemIds,
      stored: [...this.objects.values()].filter((o) => systemIds.includes(o.systemId)),
      chunks: [...this.chunks.values()].filter((c) => systemIds.includes(c.systemId)),
      rows: this.rows,
      layout: this.layout,
      worldSeed: seed,
      revisions: {
        geographyRevision: input.geography.revision,
        structureRevision: input.geography.structureRevision,
        activityRevision: input.geography.activityRevision,
        personalRevision: input.personalRevision,
        sceneRevision: this.revision,
      },
      hash,
      // The catalogue of the library plan (release 1), as every fixture here is made from it.
      catalogue: planSnapshot(),
    });
    this.layout = result.layout;
    for (const system of result.systems) {
      for (const o of system.upserts) this.objects.set(o.descriptor.objectId, o);
      for (const c of system.changed) this.chunks.set(c.chunk.chunkId, c);
      this.rows.set(system.systemId, {
        systemId: system.systemId,
        cell: system.cell,
        planetCount: system.planetCount,
        objectCount: system.objectCount,
        sceneRevision: this.revision,
      });
    }
    return result;
  }
  all(result: Result) {
    return result.systems.flatMap((s) => s.objects);
  }
}
const project = (input = fixture()) => {
  const world = new World();
  return { world, result: world.project(input) };
};
const objectsOf = (result: Result) => result.systems.flatMap((s) => s.objects);
const familyOf = (result: Result) =>
  new Map(objectsOf(result).map((o) => [o.descriptor.objectId, o.descriptor.family]));

describe('persisted Scene projection policy (authored CI fixtures)', () => {
  it('selects canonical families before seed variation and keeps exact IDs, hierarchy, truth and origins', () => {
    const input = fixture();
    const objects = [
      ...input.objects,
      place(6, 'planet', 2, 'earth.tides'),
      place(7, 'planet', 2, 'earth.greenhouse-effect'),
      place(8, 'region', 6, 'earth.tides.coasts'),
    ];
    const families = familyOf(project({ ...input, objects }).result);
    expect(families.get(id(6))).toBe('archipelago.v1');
    expect(families.get(id(7))).toBe('ridged.v1');
    expect(families.get(id(8))).toBe('archipelago.v1');
    const { result } = project({ ...input, objects });
    expect(
      objectsOf(result).every(
        (o) => o.descriptor.target.objectId === o.descriptor.objectId && o.descriptor.originTransitionId === id(9999),
      ),
    ).toBe(true);
  });
  it('draws the planets of every system from the library plan and keeps the Earth assignments', () => {
    const input = fixture();
    const objects = [
      ...input.objects,
      place(6, 'planet', 2, 'earth.tides'),
      place(7, 'planet', 2, 'earth.greenhouse-effect'),
      place(10, 'system', 1, 'space'),
      place(11, 'star', 10, 'space'),
      place(12, 'planet', 10, 'space.black-holes'),
      place(13, 'region', 12, 'space.black-holes.horizon'),
      place(20, 'system', 1, 'machine-learning'),
      place(21, 'star', 20, 'machine-learning'),
      place(22, 'planet', 20, 'machine-learning.attention'),
      place(23, 'planet', 20, 'machine-learning.transformers'),
    ];
    const families = familyOf(project({ ...input, objects }).result);
    // Earth is unchanged from before the plan held other systems.
    expect([2, 3, 4, 5, 6, 7].map((n) => families.get(id(n)))).toEqual([
      'terraced.v1',
      'terraced.v1',
      'terraced.v1',
      'terraced.v1',
      'archipelago.v1',
      'ridged.v1',
    ]);
    // Everything else comes from the plan: a system's star follows it, a planet may override it,
    // a region inherits its planet, and a planet without an override follows its system.
    expect([10, 11, 12, 13].map((n) => families.get(id(n)))).toEqual([
      'archipelago.v1',
      'archipelago.v1',
      'ridged.v1',
      'ridged.v1',
    ]);
    expect([20, 21, 22, 23].map((n) => families.get(id(n)))).toEqual([
      'ridged.v1',
      'ridged.v1',
      'terraced.v1',
      'ridged.v1',
    ]);
  });
  it('fails closed on ids the plan does not hold or holds as another kind or under another parent', () => {
    const input = fixture();
    const refused = (extra: GeographySceneInput['objects']) =>
      expect(() => project({ ...input, objects: [...input.objects, ...extra] })).toThrow(ProjectionUnavailable);
    refused([place(6, 'system', 1, 'astronomy')]);
    refused([place(6, 'planet', 2, 'earth.unknown')]);
    refused([place(6, 'planet', 2, 'earth')]);
    refused([place(6, 'system', 1, 'earth.seasons')]);
    // A planet of another system under Earth.
    refused([place(6, 'planet', 2, 'space.stars')]);
    // A facet of another planet under the Seasons planet.
    refused([place(6, 'region', 4, 'earth.tides.coasts')]);
    // A region whose parent is a system rather than a planet.
    refused([place(6, 'region', 2, 'earth.seasons.axial-tilt')]);
  });
  it('persists descriptor identity and allocation through sibling arrival, quiet, relabel and shuffled restart', () => {
    const { world, result: first } = project(),
      input = fixture();
    const before = new Map(world.objects);
    const changedObjects = [
      place(6, 'planet', 2, 'earth.tides'),
      ...input.objects.map((o) => ({
        ...o,
        label: `Renamed ${o.id.slice(-2)}`,
        activity: { availability: 'available' as const, state: 'quiet' as const },
      })),
    ].reverse();
    const changed = {
      ...input,
      personalRevision: 900,
      geography: { revision: 2, structureRevision: 2, activityRevision: 2 },
      objectCount: changedObjects.length,
      objects: changedObjects,
    };
    const restart = new World();
    for (const o of [...before.values()].reverse()) restart.objects.set(o.descriptor.objectId, o);
    for (const c of world.chunks.values()) restart.chunks.set(c.chunk.chunkId, c);
    for (const [k, r] of world.rows) restart.rows.set(k, r);
    restart.layout = world.layout;
    restart.revision = world.revision;
    const next = world.project(changed);
    for (const old of objectsOf(first)) {
      const now = world.objects.get(old.descriptor.objectId)!;
      // Nothing but the label and the activity of an object ever changes.
      expect({
        ...now,
        descriptor: { ...now.descriptor, label: old.descriptor.label, activity: old.descriptor.activity },
      }).toEqual(old);
      expect(before.get(old.descriptor.objectId)).toEqual(old);
    }
    expect(restart.project(changed).systems.map((s) => s.changed.map((c) => c.chunk))).toEqual(
      next.systems.map((s) => s.changed.map((c) => c.chunk)),
    );
  });
  it('reuses exact immutable chunks when only input stamps change; route withdrawal retains objects', () => {
    const { world } = project(),
      input = fixture();
    const next = world.project({ ...input, geography: { revision: 2, structureRevision: 2, activityRevision: 0 } });
    expect(next.systems.flatMap((s) => s.changed)).toEqual([]);
    expect(next.systems.every((s) => !s.touched)).toBe(true);
    const route = {
      id: id(101),
      kind: 'route' as const,
      fromObjectId: id(4),
      toObjectId: id(6),
      originTransitionId: id(9999),
      truthStatus: 'factual' as const,
      relationRevision: 1,
      status: 'current' as const,
    };
    const objects = [...input.objects, place(6, 'planet', 2, 'earth.tides')];
    const withRoute = project({ ...input, objects, objectCount: objects.length, routes: [route] });
    const without = withRoute.world.project({
      ...input,
      objects,
      objectCount: objects.length,
      routes: [{ ...route, status: 'withdrawn' }],
      geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
    });
    expect(objectsOf(without)).toEqual(objectsOf(withRoute.result));
    // The route chunk is replaced by an empty version, which no manifest names; the object chunk is untouched.
    const replaced = without.systems.flatMap((s) => s.changed);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.chunk).toMatchObject({ objects: [], routes: [] });
  });
  it('fails closed on unknown meanings, inherited-family mismatch, ambiguous labels and changed established identity', () => {
    const input = fixture();
    for (const objects of [
      [...input.objects.slice(0, 2), place(4, 'planet', 2, 'seasons')],
      [...input.objects.slice(0, 3), place(5, 'region', 4, 'earth.tides.coasts')],
      input.objects.map((o) => ({ ...o, label: 'https://unsafe.example' })),
    ])
      expect(() => project({ ...input, objects })).toThrow();
    const { world } = project();
    expect(() =>
      world.project({
        ...input,
        objects: input.objects.map((o) => (o.id === id(4) ? { ...o, originTransitionId: id(77) } : o)),
      }),
    ).toThrow(ProjectionUnavailable);
    // A stored place Geography no longer lists is a disagreement, never a quiet disappearance.
    expect(() => world.project({ ...input, objects: input.objects.filter((o) => o.id !== id(5)) })).toThrow(
      ProjectionUnavailable,
    );
  });
  it('fits a system of 1000 objects across bounded chunks and keeps every chunk within the parser caps', () => {
    const input = fixture(),
      objects = [
        place(2, 'system', 1, 'earth'),
        ...Array.from({ length: 999 }, (_, i) =>
          place(i + 3, 'planet', 2, ['earth.seasons', 'earth.tides', 'earth.greenhouse-effect'][i % 3]!),
        ),
      ];
    const { world, result } = project({ ...input, objects, objectCount: objects.length });
    const system = result.systems[0]!;
    expect(system.objectCount).toBe(1000);
    expect(system.planetCount).toBe(999);
    expect(new Set(objectsOf(result).map((o) => o.chunkId)).size).toBe(10);
    // Every planet has its own ordinal and its own place around the system.
    const planets = objectsOf(result).filter((o) => o.descriptor.kind === 'planet');
    expect(new Set(planets.map((o) => o.slot)).size).toBe(999);
    expect(new Set(planets.map((o) => `${o.descriptor.anchor.x},${o.descriptor.anchor.y}`)).size).toBe(999);
    for (const c of system.changed) {
      expect(c.chunk.objects.length).toBeLessThanOrEqual(100);
      expect(SceneChunkSchema.safeParse(c.chunk).success).toBe(true);
      expect(JSON.stringify(c.chunk).length).toBeLessThan(SCENE_LIMITS.bytes);
    }
    expect(world.chunks.size).toBe(10);
  });
  it('honors canonical byte/count bounds and per-system cross-chunk parent/route checks', () => {
    const input = fixture(),
      first = project(),
      chunk = first.result.systems[0]!.changed[0]!.chunk;
    expect(
      SceneChunkSchema.safeParse({ ...chunk, objects: Array.from({ length: 101 }, () => chunk.objects[0]) }).success,
    ).toBe(false);
    expect(
      SceneChunkSchema.safeParse({ ...chunk, objects: chunk.objects.map((o) => ({ ...o, label: 'x'.repeat(262145) })) })
        .success,
    ).toBe(false);
    expect(() => project({ ...input, objects: input.objects.filter((o) => o.kind !== 'system') })).toThrow();
    expect(() =>
      project({
        ...input,
        routes: [
          {
            id: id(55),
            kind: 'route',
            fromObjectId: id(4),
            toObjectId: id(999),
            truthStatus: 'factual',
            originTransitionId: id(9999),
            relationRevision: 1,
            status: 'current',
          },
        ],
      }),
    ).toThrow();
  });
  it('retains route chunk membership across earlier-sorting arrivals and withdrawal; aliases never retarget objects', () => {
    const input = fixture();
    const objects = [...input.objects, place(6, 'planet', 2, 'earth.tides')];
    const route = (n: number) => ({
      id: id(n),
      kind: 'route' as const,
      fromObjectId: id(4),
      toObjectId: id(6),
      originTransitionId: id(9999),
      truthStatus: 'factual' as const,
      relationRevision: 1,
      status: 'current' as const,
    });
    const routes = Array.from({ length: 101 }, (_, i) => route(5000 + i));
    const { world, result: first } = project({ ...input, objects, objectCount: objects.length, routes });
    const memberships = () =>
      new Map([...world.chunks.values()].flatMap((c) => c.chunk.routes.map((r) => [r.id, c.chunk.chunkId] as const)));
    const firstMembership = memberships();
    // Two route chunks of at most 100 routes each.
    expect(new Set(firstMembership.values()).size).toBe(2);
    const next = world.project({
      ...input,
      objects,
      objectCount: objects.length,
      routes: [
        route(100),
        ...routes.map((r, i) => (i === 0 ? { ...r, status: 'withdrawn' as const, relationRevision: 2 } : r)),
      ],
      geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
    });
    const nextMembership = memberships();
    for (const [routeId, chunkId] of firstMembership)
      if (routeId !== id(5000)) expect(nextMembership.get(routeId)).toBe(chunkId);
    expect(nextMembership.has(id(5000))).toBe(false);
    // The route that arrived takes the first route chunk with room, the one the withdrawal made room in.
    expect(nextMembership.get(id(100))).toBe(firstMembership.get(id(5001)));
    expect(objectsOf(next)).toEqual(objectsOf(first));
    const alias = {
      id: id(7000),
      kind: 'alias' as const,
      fromObjectId: id(4),
      toObjectId: id(6),
      originTransitionId: id(9999),
      truthStatus: 'factual' as const,
      relationRevision: 1,
      status: 'current' as const,
    };
    const aliased = project({ ...input, objects, objectCount: objects.length, aliases: [alias] });
    expect(objectsOf(aliased.result).map((o) => o.descriptor.target)).toEqual(
      objectsOf(project({ ...input, objects, objectCount: objects.length }).result).map((o) => o.descriptor.target),
    );
  });
  it('validates routes across the object chunks of one system', () => {
    const input = fixture();
    const objects = [
      place(2, 'system', 1, 'earth'),
      ...Array.from({ length: 101 }, (_, i) => place(i + 3, 'planet', 2, 'earth.seasons')),
    ];
    const route = {
      id: id(7000),
      kind: 'route' as const,
      fromObjectId: id(3),
      toObjectId: id(103),
      originTransitionId: id(9999),
      truthStatus: 'factual' as const,
      relationRevision: 1,
      status: 'current' as const,
    };
    const { result } = project({ ...input, objects, objectCount: objects.length, routes: [route] });
    const all = objectsOf(result);
    expect(all.find((o) => o.descriptor.objectId === route.fromObjectId)!.chunkId).not.toBe(
      all.find((o) => o.descriptor.objectId === route.toObjectId)!.chunkId,
    );
    const chunk = result.systems[0]!.changed.find((c) => c.chunk.routes.length)!.chunk;
    expect(
      SceneChunkSchema.safeParse({
        ...chunk,
        routes: Array.from({ length: 101 }, (_, i) => ({ ...route, id: id(8000 + i) })),
      }).success,
    ).toBe(false);
  });
});

describe('canonical-lattice.v2 layout in a projection (D-417)', () => {
  const twoSystems = (): GeographySceneInput => {
    const objects = [
      place(2, 'system', 1, 'earth'),
      place(3, 'star', 2, 'earth'),
      place(4, 'planet', 2, 'earth.seasons'),
      place(6, 'planet', 2, 'earth.tides'),
      place(7, 'planet', 2, 'earth.greenhouse-effect'),
      place(5, 'region', 4, 'earth.seasons.axial-tilt'),
      place(10, 'system', 1, 'space'),
      place(11, 'star', 10, 'space'),
      place(12, 'planet', 10, 'space.black-holes'),
    ];
    return { ...fixture(), objectCount: objects.length, objects };
  };
  it('puts systems on the coarse grid in id order, a star on its system, planets around the star and a region on its planet', () => {
    const { world, result } = project(twoSystems());
    const o = (n: number) => world.objects.get(id(n))!.descriptor;
    expect(o(2).anchor).toEqual({ ...cellAnchor(0), layer: 0 });
    expect(o(10).anchor).toEqual({ ...cellAnchor(1), layer: 0 });
    expect(o(3).anchor).toEqual({ ...o(2).anchor, layer: 1 });
    // The planets of a system take the lattice points nearest its star, in the order they arrived (id order).
    expect([4, 6, 7].map((n) => [o(n).anchor.x - o(2).anchor.x, o(n).anchor.y - o(2).anchor.y])).toEqual([
      [planetOffset(0).x, planetOffset(0).y],
      [planetOffset(1).x, planetOffset(1).y],
      [planetOffset(2).x, planetOffset(2).y],
    ]);
    expect([4, 6, 7].map((n) => world.objects.get(id(n))!.slot)).toEqual([0, 1, 2]);
    expect(o(5).anchor).toEqual({ ...o(4).anchor, layer: 3 });
    for (const n of [2, 3, 5, 10]) expect(world.objects.get(id(n))!.slot).toBeNull();
    expect([...world.objects.values()].every((s) => s.layout === LAYOUT_V2)).toBe(true);
    expect(world.layout).toEqual({ legacyReach: 0, nextCell: 2 });
    expect(result.systems.map((s) => [s.systemId, s.cell, s.planetCount, s.objectCount])).toEqual([
      [id(2), 0, 3, 6],
      [id(10), 1, 1, 3],
    ]);
    // The client's own reading of the anchors: the first planets are on the innermost orbit.
    expect(Math.hypot(o(4).anchor.x - o(3).anchor.x, o(4).anchor.y - o(3).anchor.y)).toBe(FINE_SPACING);
  });
  it('leaves every stored object exactly where it is when others arrive, and never reuses a cell or an ordinal', () => {
    const { world } = project(twoSystems());
    const before = new Map(world.objects);
    const input = twoSystems();
    const more = [
      ...input.objects,
      place(1000, 'system', 1, 'machine-learning'),
      place(1001, 'star', 1000, 'machine-learning'),
      place(1002, 'planet', 1000, 'machine-learning.attention'),
      place(8, 'planet', 2, 'earth.greenhouse-effect'),
    ];
    // A second planet with the Greenhouse meaning is a different place, in its own right.
    world.project({
      ...input,
      objects: more,
      objectCount: more.length,
      geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
    });
    for (const [objectId, old] of before) expect(world.objects.get(objectId)).toEqual(old);
    const planets = [...world.objects.values()].filter((o) => o.systemId === id(2) && o.descriptor.kind === 'planet');
    expect(planets.map((o) => o.slot).sort()).toEqual([0, 1, 2, 3]);
    expect(world.rows.get(id(1000))?.cell).toBe(2);
    expect(world.layout.nextCell).toBe(3);
  });
  it('touches only the systems a change reaches: a system whose places did not change has no new chunk or revision', () => {
    const { world } = project(twoSystems());
    const input = twoSystems();
    // Geography answers a subset read with the places of the systems asked for and nothing else.
    const asked = input.objects
      .filter((o) => [id(10), id(11), id(12)].includes(o.id))
      .map((o) => (o.id === id(12) ? { ...o, label: 'Renamed' } : o));
    const result = world.project(
      {
        ...input,
        objects: asked,
        objectCount: input.objects.length,
        geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
      },
      [id(10)],
    );
    // Only the system named was read, and only its objects chunk has a new version.
    expect(result.systems.map((s) => s.systemId)).toEqual([id(10)]);
    expect(result.systems[0]!.changed).toHaveLength(1);
    expect(result.systems[0]!.upserts.map((o) => o.descriptor.objectId)).toEqual([id(12)]);
  });
  it('lays a new system past the objects of an older layout, and a new planet around an older star without overlap', () => {
    // A world laid out by canonical-lattice.v1: a system, its star on a neighbouring slot and one planet.
    const input = twoSystems();
    const v1System = SceneDescriptorSchema.parse({
      schemaVersion: 'scene-descriptor.v1',
      generatorVersion: 'silhouette.v1',
      objectId: id(2),
      parentId: id(1),
      kind: 'system',
      originTransitionId: id(9999),
      label: 'Place 2',
      truthStatus: 'factual',
      activity: { availability: 'available', state: 'active' },
      family: 'terraced.v1',
      seed: 'b'.repeat(32),
      palette: 'ochre',
      material: 'solid',
      atmosphere: { density: 0.15 },
      detail: { roughness: 0.4 },
      anchor: { x: -150, y: -150, layer: 0 },
      target: { kind: 'system', objectId: id(2) },
    });
    const v1 = (
      n: number,
      kind: 'star' | 'planet',
      x: number,
      y: number,
      slot: number,
      family: 'terraced.v1',
    ): StoredObject => ({
      descriptor: SceneDescriptorSchema.parse({
        ...v1System,
        objectId: id(n),
        parentId: id(2),
        kind,
        label: `Place ${n}`,
        family,
        anchor: { x, y, layer: kind === 'star' ? 1 : 2 },
        target: { kind, objectId: id(n) },
      }),
      systemId: id(2),
      chunkId: id(7777),
      slot,
      layout: LAYOUT_V1,
    });
    const world = new World();
    world.objects.set(id(2), {
      descriptor: v1System,
      systemId: id(2),
      chunkId: id(7777),
      slot: 100,
      layout: LAYOUT_V1,
    });
    // Star on the slot to the right of the system, the planet one slot above the star.
    world.objects.set(id(3), v1(3, 'star', 150, -150, 101, 'terraced.v1'));
    world.objects.set(id(4), v1(4, 'planet', 150, 150, 133, 'terraced.v1'));
    world.rows.set(id(2), { systemId: id(2), cell: null, planetCount: 1, objectCount: 3, sceneRevision: 3 });
    world.layout = { legacyReach: 4650, nextCell: 0 };
    const before = new Map(world.objects);
    const objects = [
      ...input.objects.filter((o) => o.id === id(2) || o.id === id(3) || o.id === id(4)),
      place(6, 'planet', 2, 'earth.tides'),
      place(1000, 'system', 1, 'space'),
      place(1001, 'star', 1000, 'space'),
    ];
    const result = world.project({ ...input, objects, objectCount: objects.length });
    for (const [objectId, old] of before) expect(world.objects.get(objectId)).toEqual(old);
    const star = world.objects.get(id(3))!.descriptor.anchor;
    const added = world.objects.get(id(6))!;
    expect(added.layout).toBe(LAYOUT_V2);
    // Around the older star, not the system, and not where the older planet already is (300 above the star).
    const offset = { x: added.descriptor.anchor.x - star.x, y: added.descriptor.anchor.y - star.y };
    expect(offset).not.toEqual({ x: 0, y: FINE_SPACING });
    expect(Math.hypot(offset.x, offset.y)).toBe(FINE_SPACING);
    expect(added.slot).toBe(0);
    // The new system is outside the square the older layout used.
    const cell = world.rows.get(id(1000))!.cell!;
    const anchor = world.objects.get(id(1000))!.descriptor.anchor;
    expect(Math.max(Math.abs(anchor.x), Math.abs(anchor.y))).toBeGreaterThanOrEqual(4650 + SYSTEM_SPACING);
    expect(anchor).toMatchObject(cellAnchor(cell));
    expect(result.systems.find((s) => s.systemId === id(2))!.cell).toBeNull();
  });
});
