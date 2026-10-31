/** Portable JSON-native scene description and bounded numeric geometry. No rendering side effects. */
export {
  HAZE_FAMILIES,
  LOOK_LIMITS,
  PLANET_TYPES,
  SCENE_LIMITS,
  SCENE_LOOK_VERSION,
  WORLD_GENERATOR_VERSION,
} from './types.js';
export type {
  HazeFamily,
  PlanetLook,
  PlanetType,
  RegionLook,
  SceneLook,
  SystemLook,
  Point,
  SceneActivity,
  SceneAnchor,
  SceneChunk,
  SceneDescriptor,
  SceneFamily,
  SceneGeometry,
  SceneKind,
  SceneManifest,
  ScenePalette,
  SceneReturnLocator,
  SceneRevisions,
  SceneRoute,
  SceneTarget,
} from './types.js';
export {
  SceneParseError,
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SceneReturnLocatorSchema,
  SceneLookSchema,
} from './parse.js';
export type { SceneSchema } from './parse.js';
export { buildSceneGeometry } from './geometry.js';
export { seededUnit } from './seed.js';
export { buildGlobe, buildMap } from './world/build-world.js';
export { chartWorld } from './world/chart.js';
export { landmarkSpots, MAX_LANDMARK_SPOTS } from './world/landmark-spots.js';
export type { Chart, ChartedCell, RegionSite, UnreachedLand } from './world/chart.js';
export type { Loop } from './world/contours.js';
export type {
  GlobeWorld,
  MapWorld,
  Puff,
  SeaMark,
  Veil,
  World,
  WorldCell,
  WorldDecor,
  WorldSpec,
} from './world/types.js';
export type { SceneGeometryOptions } from './geometry.js';

export {
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
  SceneLookJsonSchema,
} from './json-schema.js';

export type { SceneJsonSchema } from './json-schema.js';
