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
