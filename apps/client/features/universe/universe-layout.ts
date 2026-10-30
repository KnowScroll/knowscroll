import type { SceneDescriptor, SceneRoute } from '@knowscroll/scene-core';

/**
 * Pure placement rules of the Universe screens. Every position derives from persisted anchors
 * (never from a sibling index or from activity), so a place keeps its spot when others arrive and
 * size never encodes how much was watched or read (D-006 m). No React, no clocks.
 */
export interface Vec {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface UniverseIndex {
  readonly byId: ReadonlyMap<string, SceneDescriptor>;
  readonly systems: readonly SceneDescriptor[];
  readonly stars: ReadonlyMap<string, SceneDescriptor>;
  readonly planets: ReadonlyMap<string, readonly SceneDescriptor[]>;
  readonly regions: ReadonlyMap<string, readonly SceneDescriptor[]>;
  readonly routes: readonly SceneRoute[];
}

const byLabel = (a: SceneDescriptor, b: SceneDescriptor) =>
  a.label.localeCompare(b.label) || a.objectId.localeCompare(b.objectId);

/** Groups descriptors by their parent. Order inside a group is by label, only for stable output. */
export function indexUniverse(descriptors: readonly SceneDescriptor[], routes: readonly SceneRoute[]): UniverseIndex {
  const byId = new Map(descriptors.map((d) => [d.objectId, d]));
  const stars = new Map<string, SceneDescriptor>();
  const planets = new Map<string, SceneDescriptor[]>();
  const regions = new Map<string, SceneDescriptor[]>();
  const push = (groups: Map<string, SceneDescriptor[]>, parentId: string, d: SceneDescriptor) =>
    groups.set(parentId, [...(groups.get(parentId) ?? []), d]);
  for (const d of descriptors) {
    if (d.kind === 'star') stars.set(d.parentId, d);
    else if (d.kind === 'planet') push(planets, d.parentId, d);
    else if (d.kind === 'region') push(regions, d.parentId, d);
  }
  for (const group of [...planets.values(), ...regions.values()]) group.sort(byLabel);
  return {
    byId,
    systems: descriptors.filter((d) => d.kind === 'system').sort(byLabel),
    stars,
    planets,
    regions,
    routes,
  };
}

/** The places that contain a place, nearest first: a region's planet, then its system. */
export function placeTrail(index: UniverseIndex, place: SceneDescriptor): readonly string[] {
  const trail: string[] = [];
  for (
    let parent = index.byId.get(place.parentId);
    parent && trail.length < 3;
    parent = index.byId.get(parent.parentId)
  )
    trail.push(parent.label);
  return trail;
}

/** Which of the three screens a focused place opens: the whole map, a system (U02) or a planet (U03). */
export type UniverseView =
  | { readonly kind: 'universe' }
  | { readonly kind: 'system'; readonly system: SceneDescriptor }
  | { readonly kind: 'planet'; readonly planet: SceneDescriptor; readonly selectedRegion?: SceneDescriptor };

export function viewFor(index: UniverseIndex, focusId: string | null): UniverseView {
  const focus = focusId ? index.byId.get(focusId) : undefined;
  if (!focus) return { kind: 'universe' };
  if (focus.kind === 'system') return { kind: 'system', system: focus };
  if (focus.kind === 'star') {
    const system = index.byId.get(focus.parentId);
    return system ? { kind: 'system', system } : { kind: 'universe' };
  }
  if (focus.kind === 'planet') return { kind: 'planet', planet: focus };
  const planet = index.byId.get(focus.parentId);
  return planet ? { kind: 'planet', planet, selectedRegion: focus } : { kind: 'universe' };
}

const difference = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const length = (v: Vec) => Math.hypot(v.x, v.y);

/** Where a region pin sits on its planet's disc, as a fraction of the disc radius from its centre. */
export interface PlacedRegion {
  readonly descriptor: SceneDescriptor;
  readonly offset: Vec;
}

/** Spots on a planet's land, 75 px or more apart on a phone, in the order a region tries them. */
const REGION_SPOTS: readonly Vec[] = [
  ...Array.from({ length: 6 }, (_, step) => {
    const angle = (Math.PI / 3) * step + Math.PI / 6;
    return { x: Math.cos(angle) * 0.5, y: Math.sin(angle) * 0.5 };
  }),
  { x: 0, y: 0 },
  ...Array.from({ length: 3 }, (_, step) => {
    const angle = ((Math.PI * 2) / 3) * step + Math.PI / 2;
    return { x: Math.cos(angle) * 0.72, y: Math.sin(angle) * 0.72 };
  }),
];

/**
 * Region pins sit on the land, spread apart. Regions take their spots in the order they were
 * created (the IDs are time-ordered): the first by its own seed, each later one on the free spot
 * farthest from those already placed. A region that is placed never moves when another arrives.
 * The lattice slots in the anchors are not used: they crowd onto whichever side of a planet was
 * free, which would draw its regions in a heap.
 */
export function composeRegions(index: UniverseIndex, planet: SceneDescriptor): readonly PlacedRegion[] {
  const regions = [...(index.regions.get(planet.objectId) ?? [])].sort((a, b) => a.objectId.localeCompare(b.objectId));
  const placed: PlacedRegion[] = [];
  for (const descriptor of regions) {
    const free = REGION_SPOTS.filter((spot) => !placed.some((region) => region.offset === spot));
    const candidates = free.length ? free : REGION_SPOTS;
    const [seedUnit] = unitsFromId(descriptor.seed);
    const offset = placed.length
      ? candidates.reduce((best, spot) => {
          const gap = (candidate: Vec) =>
            Math.min(...placed.map((region) => length(difference(candidate, region.offset))));
          return gap(spot) > gap(best) + 1e-9 ? spot : best;
        })
      : candidates[Math.floor(seedUnit * candidates.length) % candidates.length]!;
    placed.push({ descriptor, offset });
  }
  return placed;
}

/** Deterministic unit-interval numbers from an opaque ID, for decoration only. */
export function unitsFromId(id: string): readonly [number, number] {
  const hex = id.replaceAll('-', '');
  return [Number.parseInt(hex.slice(0, 8), 16) / 0xffffffff, Number.parseInt(hex.slice(8, 12), 16) / 0xffff];
}

export interface LabelRequest {
  readonly id: string;
  /** Screen position of the thing being named. */
  readonly anchor: Vec;
  /** Distance from the anchor to clear its body. */
  readonly clearance: number;
  readonly width: number;
  readonly height: number;
  /** Higher first. Ties keep input order. */
  readonly priority: number;
}
export interface PlacedLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const overlaps = (a: PlacedLabel, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Labels never overlap each other or a blocker (a body or control). A label that finds no free
 * spot (below, above, right, left of its anchor) is left out; its body keeps its accessible name.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  bounds: Size,
  blockers: readonly { x: number; y: number; width: number; height: number }[] = [],
): readonly PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const ordered = requests
    .map((request, order) => ({ request, order }))
    .sort((a, b) => b.request.priority - a.request.priority || a.order - b.order);
  for (const { request } of ordered) {
    const { anchor, clearance, width, height } = request;
    const candidates = [
      { x: anchor.x - width / 2, y: anchor.y + clearance },
      { x: anchor.x - width / 2, y: anchor.y - clearance - height },
      { x: anchor.x + clearance, y: anchor.y - height / 2 },
      { x: anchor.x - clearance - width, y: anchor.y - height / 2 },
    ];
    const spot = candidates.find((candidate) => {
      const box = { id: request.id, ...candidate, width, height };
      return (
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + width <= bounds.width &&
        box.y + height <= bounds.height &&
        !placed.some((other) => overlaps(box, other)) &&
        !blockers.some((blocker) => overlaps(box, blocker))
      );
    });
    if (spot) placed.push({ id: request.id, ...spot, width, height });
  }
  return placed;
}

/** No recent activity. Quiet only changes how a place is drawn and listed, never whether it exists. */
export const isQuiet = (place: SceneDescriptor) =>
  place.activity.availability === 'available' && place.activity.state === 'quiet';

export interface OutlineRow {
  readonly place: SceneDescriptor;
  readonly depth: 0 | 1 | 2;
}

/**
 * The accessible outline of the whole map: every system, its planets and their regions, nothing
 * left out. With Lately on, places with recent activity come first in each group; that changes
 * the order only, never what is listed.
 */
export function outlineRows(index: UniverseIndex, lately: boolean): readonly OutlineRow[] {
  const ordered = (places: readonly SceneDescriptor[]) =>
    lately ? [...places].sort((a, b) => Number(isQuiet(a)) - Number(isQuiet(b))) : places;
  return ordered(index.systems).flatMap((system) => [
    { place: system, depth: 0 as const },
    ...ordered(index.planets.get(system.objectId) ?? []).flatMap((planet) => [
      { place: planet, depth: 1 as const },
      ...(index.regions.get(planet.objectId) ?? []).map((region) => ({ place: region, depth: 2 as const })),
    ]),
  ]);
}
