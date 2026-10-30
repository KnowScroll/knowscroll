/** Transport/generation ceilings, never formation or consumption thresholds. */
export const SCENE_LIMITS = {
  bytes: 262_144,
  depth: 12,
  nodes: 12_000,
  objectsPerChunk: 100,
  routesPerChunk: 100,
  chunksPerManifest: 128,
  coordinate: 10_000,
  silhouettePoints: 64,
} as const;

/** The six painted planet types of the New Universe, in the pinned order the assignment rule uses. */
export const PLANET_TYPES = ['lush', 'ocean', 'frozen', 'scorched', 'barren', 'gas'] as const;
export type PlanetType = (typeof PLANET_TYPES)[number];
/** The haze colours of a system, in the order the library plan names them. */
export const HAZE_FAMILIES = ['teal', 'cobalt', 'coral', 'amber', 'pink', 'violet'] as const;
export type HazeFamily = (typeof HAZE_FAMILIES)[number];
export const SCENE_LOOK_VERSION = 'scene-look.v1' as const;
/** The generator version a look pins. A client that does not declare it is not given looks. */
export const WORLD_GENERATOR_VERSION = 'worldmap.v1' as const;
/** Bounds of the look data, never formation or consumption thresholds. */
export const LOOK_LIMITS = {
  /** Largest turn of a planet's hue, in degrees either way. */
  hueShift: 180,
  /** Planets of one type a universe can hold (the object ceiling). */
  variant: 1000,
  /** Sites on one planet: one per facet. */
  sites: 32,
} as const;

export type SceneKind = 'system' | 'star' | 'planet' | 'region';
export type SceneFamily = 'terraced.v1' | 'ridged.v1' | 'archipelago.v1';
export type ScenePalette = 'cobalt' | 'ochre' | 'sage';
export interface Point {
  x: number;
  y: number;
}
export interface SceneAnchor extends Point {
  layer: number;
}
export type SceneActivity = { availability: 'available'; state: 'active' | 'quiet' } | { availability: 'unavailable' };
export interface SceneTarget {
  kind: SceneKind;
  objectId: string;
}

/** All identities, meaning, family choices and anchors come from the owning projector. */
export interface SceneDescriptor {
  schemaVersion: 'scene-descriptor.v1';
  generatorVersion: 'silhouette.v1';
  objectId: string;
  parentId: string;
  kind: SceneKind;
  originTransitionId: string;
  label: string;
  truthStatus: 'factual' | 'hypothetical';
  activity: SceneActivity;
  family: SceneFamily;
  seed: string;
  palette: ScenePalette;
  material: 'solid' | 'banded' | 'granular';
  atmosphere: { density: number };
  detail: { roughness: number };
  anchor: SceneAnchor;
  target: SceneTarget;
}
interface SceneLookBase {
  schemaVersion: typeof SCENE_LOOK_VERSION;
  generatorVersion: typeof WORLD_GENERATOR_VERSION;
  objectId: string;
}
/** A system's haze: the colour around its orange sun. */
export interface SystemLook extends SceneLookBase {
  kind: 'system';
  haze: HazeFamily;
}
/**
 * How a planet is painted and how many sites its world has. `variant` counts the planets of the same
 * type that were assigned before it, so a repeated type changes hue and layout. `siteCount` is a
 * site for each facet of the planet plus a few spare ones for facets the plan appends later; the world
 * generator lays all of them out from the planet's seed, and the unused ones draw as decorative grey.
 */
export interface PlanetLook extends SceneLookBase {
  kind: 'planet';
  type: PlanetType;
  rings: boolean;
  moon: boolean;
  hueShift: number;
  variant: number;
  siteCount: number;
}
/** The site a region occupies on its planet's world: the ordinal of its facet. */
export interface RegionLook extends SceneLookBase {
  kind: 'region';
  site: number;
}
/**
 * Look data persisted once per object (D-102). Stars have none. It carries no activity, count,
 * support or time, so it can never encode reading.
 */
export type SceneLook = SystemLook | PlanetLook | RegionLook;

export interface SceneRevisions {
  geographyRevision: number;
  structureRevision: number;
  activityRevision: number;
  sceneRevision: number;
  personalRevision: number;
}
export interface SceneRoute {
  id: string;
  fromObjectId: string;
  toObjectId: string;
  originTransitionId: string;
  truthStatus: 'factual' | 'hypothetical';
}
export interface SceneChunk {
  schemaVersion: 'scene-chunk.v1';
  chunkId: string;
  revisions: SceneRevisions;
  objects: SceneDescriptor[];
  routes: SceneRoute[];
}
export interface SceneManifest {
  schemaVersion: 'scene-manifest.v1';
  revisions: SceneRevisions;
  /** Only currently permitted chunk references. This list itself grants no access. */
  chunks: { chunkId: string; sceneRevision: number; objectIds: string[] }[];
}
/** Client-owned navigation metadata, not a formation-shown acknowledgement or authority token. */
export interface SceneReturnLocator {
  schemaVersion: 'scene-return.v1';
  chunkId: string;
  objectId: string | null;
  frame: { x: number; y: number; scale: number };
}
export interface SceneGeometry {
  objectId: string;
  parentId: string;
  originTransitionId: string;
  generatorVersion: 'silhouette.v1';
  target: SceneTarget;
  anchor: SceneAnchor;
  label: string;
  truthStatus: 'factual' | 'hypothetical';
  activity: SceneActivity;
  palette: ScenePalette;
  material: SceneDescriptor['material'];
  radius: number;
  /** Closed by the renderer. Numeric vertices only; never SVG, code or a URL. */
  silhouette: Point[];
  atmosphereRadius: number;
  /** Decorative hint only, independent of geometry and existence. Never an animation clock. */
  motion: 'still' | 'gentle';
}
