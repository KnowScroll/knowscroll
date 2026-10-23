import { SCENE_LIMITS } from './types.js';

/** Structural documentation only. The canonical parsers also enforce total byte/depth/node caps,
 * ordinary JSON ownership and cross-field identity/hierarchy/uniqueness invariants. */
export interface SceneJsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'null';
  properties?: Record<string, SceneJsonSchema>;
  additionalProperties?: boolean;
  required?: string[];
  items?: SceneJsonSchema;
  anyOf?: SceneJsonSchema[];
  enum?: string[];
  const?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  description?: string;
}
const object = (properties: Record<string, SceneJsonSchema>): SceneJsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const choice = (...values: string[]): SceneJsonSchema => ({ type: 'string', enum: values });
const number = (minimum: number, maximum: number, integer = false): SceneJsonSchema => ({
  type: integer ? 'integer' : 'number',
  minimum,
  maximum,
});
const counter = number(0, Number.MAX_SAFE_INTEGER, true);
const id: SceneJsonSchema = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
};
const list = (items: SceneJsonSchema, maxItems: number): SceneJsonSchema => ({ type: 'array', items, maxItems });
const revisions = object({
  geographyRevision: counter,
  structureRevision: counter,
  activityRevision: counter,
  sceneRevision: counter,
  personalRevision: {
    ...counter,
    description:
      'Personal-root watermark read with this projection input; not the current root or a Personal Context revision.',
  },
});
const kind = choice('system', 'star', 'planet', 'region');
const truthStatus = choice('factual', 'hypothetical');

export const SceneDescriptorJsonSchema = object({
  schemaVersion: { type: 'string', const: 'scene-descriptor.v1' },
  generatorVersion: { type: 'string', const: 'silhouette.v1' },
  objectId: id,
  parentId: id,
  kind,
  originTransitionId: id,
  label: {
    type: 'string',
    minLength: 1,
    maxLength: 160,
    description: 'Nonblank plain label; the canonical parser rejects controls, markup and URL schemes.',
  },
  truthStatus,
  activity: {
    anyOf: [
      object({ availability: choice('available'), state: choice('active', 'quiet') }),
      object({ availability: choice('unavailable') }),
    ],
  },
  family: choice('terraced.v1', 'ridged.v1', 'archipelago.v1'),
  seed: { type: 'string', pattern: '^[0-9a-f]{32}$' },
  palette: choice('cobalt', 'ochre', 'sage'),
  material: choice('solid', 'banded', 'granular'),
  atmosphere: object({ density: number(0, 1) }),
  detail: object({ roughness: number(0, 1) }),
  anchor: object({
    x: number(-SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
    y: number(-SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
    layer: number(-16, 16, true),
  }),
  target: object({ kind, objectId: id }),
});
export const SceneChunkJsonSchema = object({
  schemaVersion: { type: 'string', const: 'scene-chunk.v1' },
  chunkId: id,
  revisions,
  objects: list(SceneDescriptorJsonSchema, SCENE_LIMITS.objectsPerChunk),
  routes: list(
    object({ id, fromObjectId: id, toObjectId: id, originTransitionId: id, truthStatus }),
    SCENE_LIMITS.routesPerChunk,
  ),
});
export const SceneManifestJsonSchema = object({
  schemaVersion: { type: 'string', const: 'scene-manifest.v1' },
  revisions,
  chunks: list(
    object({
      chunkId: id,
      sceneRevision: counter,
      objectIds: { ...list(id, SCENE_LIMITS.objectsPerChunk), uniqueItems: true },
    }),
    SCENE_LIMITS.chunksPerManifest,
  ),
});
export const SceneReturnLocatorJsonSchema = object({
  schemaVersion: { type: 'string', const: 'scene-return.v1' },
  chunkId: id,
  objectId: { anyOf: [id, { type: 'null' }] },
  frame: object({
    x: number(-SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
    y: number(-SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
    scale: number(0.125, 16),
  }),
});
