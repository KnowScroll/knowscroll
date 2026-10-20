import {
  SCENE_LIMITS,
  type SceneActivity,
  type SceneChunk,
  type SceneDescriptor,
  type SceneManifest,
  type SceneReturnLocator,
  type SceneRevisions,
  type SceneRoute,
  type SceneTarget,
} from './types.js';

type RecordValue = Record<string, unknown>;
/** Stable generic failure; rejected private input is never interpolated into diagnostics. */
export class SceneParseError extends Error {
  constructor() {
    super('Invalid or unsupported bounded scene data.');
    this.name = 'SceneParseError';
  }
}
function fail(): never {
  throw new SceneParseError();
}

/** UTF-8 cost, optionally including JSON string quoting/escapes, without invoking user code. */
function stringBytes(input: string, escaped: boolean): number {
  if (input.length > SCENE_LIMITS.bytes) fail();
  let bytes = escaped ? 2 : 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (escaped && (code < 32 || code === 34 || code === 92)) bytes += code < 32 ? 6 : 2;
    else if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < input.length &&
      input.charCodeAt(i + 1) >= 0xdc00 &&
      input.charCodeAt(i + 1) <= 0xdfff
    ) {
      i++;
      bytes += 4;
    } else bytes += escaped && code >= 0xd800 && code <= 0xdfff ? 6 : 3;
    if (bytes > SCENE_LIMITS.bytes) fail();
  }
  return bytes;
}

/**
 * Copy JSON data before parsing: bounded work, no getters, toJSON, coercion or functions invoked.
 * Object entry accepts ordinary JSON records/arrays only. A hostile Proxy is not JSON data;
 * untrusted transport should use parseJson, whose sole input is a bounded JSON string.
 */
function jsonData(input: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > SCENE_LIMITS.nodes || depth > SCENE_LIMITS.depth) fail();
    bytes += 2; // Container delimiters or a value separator, conservatively.
    if (value === null || typeof value === 'boolean') {
      bytes += 5;
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail();
      bytes += 24;
      return value;
    }
    if (typeof value === 'string') {
      bytes += stringBytes(value, true);
      if (bytes > SCENE_LIMITS.bytes) fail();
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) fail();
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length > SCENE_LIMITS.nodes - nodes) fail();
    ancestors.add(value);
    const output: unknown[] | RecordValue = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') fail();
      bytes += stringBytes(key, true) + 1;
      if (bytes > SCENE_LIMITS.bytes) fail();
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property) || !property.enumerable) fail();
      if (array) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) !== output.length) fail();
        (output as unknown[]).push(copy(property.value, depth + 1));
      } else {
        (output as RecordValue)[key] = copy(property.value, depth + 1);
      }
    }
    if (array && (output as unknown[]).length !== (value as unknown[]).length) fail();
    ancestors.delete(value);
    if (bytes > SCENE_LIMITS.bytes) fail();
    return output;
  }
  return copy(input, 0);
}
function record(value: unknown, keys: readonly string[]): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as RecordValue;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) fail();
  return result;
}
function text(value: unknown, max = 160): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    !value.trim() ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
    /[<>]|(?:https?:|data:|javascript:|\/\/)/i.test(value)
  )
    fail();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    fail();
  return value;
}
function number(value: unknown, min: number, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    fail();
  return value;
}
function choice<const T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail();
  return value as T;
}
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map(parse);
}
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) fail();
}
function activity(value: unknown): SceneActivity {
  const available = (value as RecordValue | null)?.availability === 'available';
  const r = record(value, available ? ['availability', 'state'] : ['availability']);
  return available
    ? { availability: 'available', state: choice(r.state, ['active', 'quiet']) }
    : { availability: choice(r.availability, ['unavailable']) };
}
function target(value: unknown): SceneTarget {
  const r = record(value, ['kind', 'objectId']);
  return { kind: choice(r.kind, ['system', 'star', 'planet', 'region']), objectId: id(r.objectId) };
}
function revisions(value: unknown): SceneRevisions {
  const keys = [
    'geographyRevision',
    'structureRevision',
    'activityRevision',
    'sceneRevision',
    'personalRevision',
  ] as const;
  const r = record(value, keys);
  return Object.fromEntries(
    keys.map((key) => [key, number(r[key], 0, Number.MAX_SAFE_INTEGER, true)]),
  ) as unknown as SceneRevisions;
}
function descriptor(value: unknown): SceneDescriptor {
  const r = record(value, [
    'schemaVersion',
    'generatorVersion',
    'objectId',
    'parentId',
    'kind',
    'originTransitionId',
    'label',
    'truthStatus',
    'activity',
    'family',
    'seed',
    'palette',
    'material',
    'atmosphere',
    'detail',
    'anchor',
    'target',
  ]);
  const a = record(r.anchor, ['x', 'y', 'layer']);
  const d = record(r.detail, ['roughness']);
  const atmosphere = record(r.atmosphere, ['density']);
  if (typeof r.seed !== 'string' || !/^[0-9a-f]{32}$/.test(r.seed)) fail();
  const result: SceneDescriptor = {
    schemaVersion: choice(r.schemaVersion, ['scene-descriptor.v1']),
    generatorVersion: choice(r.generatorVersion, ['silhouette.v1']),
    objectId: id(r.objectId),
    parentId: id(r.parentId),
    kind: choice(r.kind, ['system', 'star', 'planet', 'region']),
    originTransitionId: id(r.originTransitionId),
    label: text(r.label),
    truthStatus: choice(r.truthStatus, ['factual', 'hypothetical']),
    activity: activity(r.activity),
    family: choice(r.family, ['terraced.v1', 'ridged.v1', 'archipelago.v1']),
    seed: r.seed,
    palette: choice(r.palette, ['cobalt', 'ochre', 'sage']),
    material: choice(r.material, ['solid', 'banded', 'granular']),
    atmosphere: { density: number(atmosphere.density, 0, 1) },
    detail: { roughness: number(d.roughness, 0, 1) },
    anchor: {
      x: number(a.x, -SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
      y: number(a.y, -SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
      layer: number(a.layer, -16, 16, true),
    },
    target: target(r.target),
  };
  if (
    result.objectId === result.parentId ||
    result.target.objectId !== result.objectId ||
    result.target.kind !== result.kind
  )
    fail();
  return result;
}
function route(value: unknown): SceneRoute {
  const r = record(value, ['id', 'fromObjectId', 'toObjectId', 'originTransitionId', 'truthStatus']);
  const result = {
    id: id(r.id),
    fromObjectId: id(r.fromObjectId),
    toObjectId: id(r.toObjectId),
    originTransitionId: id(r.originTransitionId),
    truthStatus: choice(r.truthStatus, ['factual', 'hypothetical']),
  };
  if (result.fromObjectId === result.toObjectId) fail();
  return result;
}
function chunk(value: unknown): SceneChunk {
  const r = record(value, ['schemaVersion', 'chunkId', 'revisions', 'objects', 'routes']);
  const objects = list(r.objects, SCENE_LIMITS.objectsPerChunk, descriptor);
  const routes = list(r.routes, SCENE_LIMITS.routesPerChunk, route);
  unique(objects.map((o) => o.objectId));
  unique(routes.map((o) => o.id));
  // Cross-chunk parents/endpoints may be absent. Validate known local hierarchy without inventing it.
  const byId = new Map(objects.map((o) => [o.objectId, o]));
  for (const object of objects) {
    const parent = byId.get(object.parentId);
    if (parent && (object.kind === 'system' || parent.kind !== (object.kind === 'region' ? 'planet' : 'system')))
      fail();
  }
  return {
    schemaVersion: choice(r.schemaVersion, ['scene-chunk.v1']),
    chunkId: id(r.chunkId),
    revisions: revisions(r.revisions),
    objects,
    routes,
  };
}
function manifest(value: unknown): SceneManifest {
  const r = record(value, ['schemaVersion', 'revisions', 'chunks']);
  const chunks = list(r.chunks, SCENE_LIMITS.chunksPerManifest, (entry) => {
    const c = record(entry, ['chunkId', 'sceneRevision', 'objectIds']);
    const objectIds = list(c.objectIds, SCENE_LIMITS.objectsPerChunk, id);
    unique(objectIds);
    return {
      chunkId: id(c.chunkId),
      sceneRevision: number(c.sceneRevision, 0, Number.MAX_SAFE_INTEGER, true),
      objectIds,
    };
  });
  unique(chunks.map((c) => c.chunkId));
  unique(chunks.flatMap((c) => c.objectIds));
  return { schemaVersion: choice(r.schemaVersion, ['scene-manifest.v1']), revisions: revisions(r.revisions), chunks };
}
function locator(value: unknown): SceneReturnLocator {
  const r = record(value, ['schemaVersion', 'chunkId', 'objectId', 'frame']);
  const f = record(r.frame, ['x', 'y', 'scale']);
  return {
    schemaVersion: choice(r.schemaVersion, ['scene-return.v1']),
    chunkId: id(r.chunkId),
    objectId: r.objectId === null ? null : id(r.objectId),
    frame: {
      x: number(f.x, -SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
      y: number(f.y, -SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate),
      scale: number(f.scale, 0.125, 16),
    },
  };
}
export interface SceneSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: SceneParseError };
  parseJson(input: string): T;
}
function schema<T>(parse: (input: unknown) => T): SceneSchema<T> {
  const parseValue = (input: unknown): T => parse(jsonData(input));
  return {
    parse: parseValue,
    safeParse(input) {
      try {
        return { success: true, data: parseValue(input) };
      } catch {
        return { success: false, error: new SceneParseError() };
      }
    },
    parseJson(input) {
      if (typeof input !== 'string' || input.length > SCENE_LIMITS.bytes) fail();
      // Reject excessive wire bytes before allocating the parsed JSON structure.
      stringBytes(input, false);
      try {
        return parseValue(JSON.parse(input) as unknown);
      } catch {
        return fail();
      }
    },
  };
}
export const SceneDescriptorSchema = schema(descriptor);
export const SceneChunkSchema = schema(chunk);
export const SceneManifestSchema = schema(manifest);
export const SceneReturnLocatorSchema = schema(locator);
