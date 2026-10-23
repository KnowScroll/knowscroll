/** Portable JSON-native scene description and bounded numeric geometry. No rendering side effects. */
export { SCENE_LIMITS } from './types.js';
export type {
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
} from './parse.js';
export type { SceneSchema } from './parse.js';
export { buildSceneGeometry } from './geometry.js';
export type { SceneGeometryOptions } from './geometry.js';

export {
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
} from './json-schema.js';

export type { SceneJsonSchema } from './json-schema.js';
