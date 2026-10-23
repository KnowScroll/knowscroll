import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SceneChunkSchema, SceneManifestSchema, SCENE_LIMITS } from '@knowscroll/contracts';
import type { GeographySceneInput } from '../../geography/public.js';
import { projectBounded, ProjectionUnavailable } from './projection.js';
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
  return {
    universeId: id(1),
    privacyEpoch: 1,
    personalRevision: 71,
    geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
    objects: [
      place(2, 'system', 1, 'earth'),
      place(3, 'star', 2, 'earth'),
      place(4, 'planet', 2, 'earth.seasons'),
      place(5, 'region', 4, 'earth.seasons.axial-tilt'),
    ],
    routes: [],
    aliases: [],
  };
}
const project = (input = fixture()) => projectBounded(input, [], [], seed, 1, hash);
describe('persisted Scene projection policy (authored CI fixtures)', () => {
  it('selects canonical families before seed variation and keeps exact IDs, hierarchy, truth and origins', () => {
    const input = fixture();
    const objects = [
      ...input.objects,
      place(6, 'planet', 2, 'earth.tides'),
      place(7, 'planet', 2, 'earth.greenhouse-effect'),
      place(8, 'region', 6, 'earth.tides.coasts'),
    ];
    const p = project({ ...input, objects });
    expect(p.objects.map((o) => [o.descriptor.objectId, o.descriptor.family])).toContainEqual([
      id(6),
      'archipelago.v1',
    ]);
    expect(p.objects.map((o) => [o.descriptor.objectId, o.descriptor.family])).toContainEqual([id(7), 'ridged.v1']);
    expect(p.objects.map((o) => [o.descriptor.objectId, o.descriptor.family])).toContainEqual([
      id(8),
      'archipelago.v1',
    ]);
    expect(
      p.objects.every(
        (o) => o.descriptor.target.objectId === o.descriptor.objectId && o.descriptor.originTransitionId === id(9999),
      ),
    ).toBe(true);
    expect(new Set(p.objects.map((o) => o.slot)).size).toBe(objects.length);
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
    const families = new Map(
      project({ ...input, objects }).objects.map((o) => [o.descriptor.objectId, o.descriptor.family]),
    );
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
    const first = project(),
      input = fixture();
    const changed = {
      ...input,
      personalRevision: 900,
      geography: { revision: 2, structureRevision: 2, activityRevision: 2 },
      objects: [
        place(6, 'planet', 2, 'earth.tides'),
        ...input.objects.map((o) => ({
          ...o,
          label: `Renamed ${o.id.slice(-2)}`,
          activity: { availability: 'available' as const, state: 'quiet' as const },
        })),
      ].reverse(),
    };
    const next = projectBounded(changed, first.objects, first.changed, seed, 2, hash);
    for (const old of first.objects) {
      const now = next.objects.find((o) => o.descriptor.objectId === old.descriptor.objectId)!;
      expect({
        ...now,
        descriptor: { ...now.descriptor, label: old.descriptor.label, activity: old.descriptor.activity },
      }).toEqual(old);
    }
    expect(projectBounded(changed, [...first.objects].reverse(), first.changed, seed, 2, hash).manifest).toEqual(
      next.manifest,
    );
  });
  it('reuses exact immutable chunks when only input stamps change; route withdrawal retains objects', () => {
    const first = project(),
      input = fixture();
    const next = projectBounded(
      { ...input, geography: { revision: 2, structureRevision: 2, activityRevision: 0 } },
      first.objects,
      first.changed,
      seed,
      2,
      hash,
    );
    expect(next.changed).toEqual([]);
    expect(next.manifest.chunks).toEqual(first.manifest.chunks);
    expect(next.manifest.revisions.geographyRevision).toBe(2);
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
    const withRoute = project({
      ...input,
      objects: [...input.objects, place(6, 'planet', 2, 'earth.tides')],
      routes: [route],
    });
    const without = projectBounded(
      {
        ...input,
        objects: [...input.objects, place(6, 'planet', 2, 'earth.tides')],
        routes: [{ ...route, status: 'withdrawn' }],
        geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
      },
      withRoute.objects,
      withRoute.changed,
      seed,
      2,
      hash,
    );
    expect(without.objects).toEqual(withRoute.objects);
    expect(without.manifest.chunks).toHaveLength(withRoute.manifest.chunks.length - 1);
  });
  it('fails closed on unknown meanings, inherited-family mismatch, ambiguous labels and changed established identity', () => {
    const input = fixture();
    for (const objects of [
      [...input.objects.slice(0, 2), place(4, 'planet', 2, 'seasons')],
      [...input.objects.slice(0, 3), place(5, 'region', 4, 'earth.tides.coasts')],
      input.objects.map((o) => ({ ...o, label: 'https://unsafe.example' })),
    ])
      expect(() => project({ ...input, objects })).toThrow();
    const first = project();
    expect(() =>
      projectBounded(
        { ...input, objects: input.objects.map((o) => (o.id === id(4) ? { ...o, originTransitionId: id(77) } : o)) },
        first.objects,
        first.changed,
        seed,
        2,
        hash,
      ),
    ).toThrow(ProjectionUnavailable);
  });
  it('fits the full finite 1000-object lattice across bounded chunks and rejects overflow atomically', () => {
    const input = fixture(),
      objects = [
        place(2, 'system', 1, 'earth'),
        ...Array.from({ length: 999 }, (_, i) =>
          place(i + 3, 'planet', 2, ['earth.seasons', 'earth.tides', 'earth.greenhouse-effect'][i % 3]!),
        ),
      ];
    const p = project({ ...input, objects });
    expect(p.objects).toHaveLength(1000);
    expect(new Set(p.objects.map((o) => o.slot)).size).toBe(1000);
    expect(p.manifest.chunks).toHaveLength(10);
    for (const c of p.changed) {
      expect(c.chunk.objects.length).toBeLessThanOrEqual(100);
      expect(SceneChunkSchema.safeParse(c.chunk).success).toBe(true);
      expect(JSON.stringify(c.chunk).length).toBeLessThan(SCENE_LIMITS.bytes);
    }
    expect(SceneManifestSchema.safeParse(p.manifest).success).toBe(true);
    expect(() => project({ ...input, objects: [...objects, place(2000, 'planet', 2, 'earth.seasons')] })).toThrow(
      ProjectionUnavailable,
    );
    const excessive = Array.from({ length: 1001 }, (_, i) => ({
      id: id(i + 3000),
      kind: 'route' as const,
      fromObjectId: id(3),
      toObjectId: id(4),
      originTransitionId: id(9999),
      truthStatus: 'factual' as const,
      relationRevision: 1,
      status: 'current' as const,
    }));
    expect(() => project({ ...input, routes: excessive })).toThrow(ProjectionUnavailable);
  });
  it('honors canonical byte/count bounds and global cross-chunk parent/route checks', () => {
    const input = fixture(),
      first = project(),
      chunk = first.changed[0]!.chunk;
    expect(
      SceneChunkSchema.safeParse({ ...chunk, objects: Array.from({ length: 101 }, () => chunk.objects[0]) }).success,
    ).toBe(false);
    expect(
      SceneManifestSchema.safeParse({
        ...first.manifest,
        chunks: Array.from({ length: 129 }, () => first.manifest.chunks[0]),
      }).success,
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
  it('retains route bucket membership across earlier-sorting arrivals and withdrawal; aliases never retarget objects', () => {
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
    const first = project({ ...input, objects, routes });
    const next = projectBounded(
      {
        ...input,
        objects,
        routes: [
          route(100),
          ...routes.map((r, i) => (i === 0 ? { ...r, status: 'withdrawn' as const, relationRevision: 2 } : r)),
        ],
        geography: { revision: 2, structureRevision: 2, activityRevision: 0 },
      },
      first.objects,
      first.changed,
      seed,
      2,
      hash,
      first.routeChunks,
    );
    for (const membership of first.routeChunks)
      expect(next.routeChunks.find((r) => r.routeId === membership.routeId)).toEqual(membership);
    expect(next.objects).toEqual(first.objects);
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
    const aliased = project({ ...input, objects, aliases: [alias] });
    expect(aliased.objects.map((o) => o.descriptor.target)).toEqual(
      project({ ...input, objects }).objects.map((o) => o.descriptor.target),
    );
  });
  it('validates cross-chunk routes against the whole projection and refuses total chunk/route parser caps', () => {
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
    const p = project({ ...input, objects, routes: [route] });
    expect(p.objects.find((o) => o.descriptor.objectId === route.fromObjectId)!.chunkId).not.toBe(
      p.objects.find((o) => o.descriptor.objectId === route.toObjectId)!.chunkId,
    );
    expect(p.changed.some((c) => c.chunk.routes.some((r) => r.id === route.id))).toBe(true);
    const chunk = p.changed.find((c) => c.chunk.routes.length)!.chunk;
    expect(
      SceneChunkSchema.safeParse({
        ...chunk,
        routes: Array.from({ length: 101 }, (_, i) => ({ ...route, id: id(8000 + i) })),
      }).success,
    ).toBe(false);
    expect(() =>
      project({ ...input, objects: Array.from({ length: 129 }, (_, i) => place(i + 2, 'system', 1, 'earth')) }),
    ).toThrow(ProjectionUnavailable);
  });
});
