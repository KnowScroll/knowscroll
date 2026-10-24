import { buildSceneGeometry, type SceneDescriptor, type SceneGeometry } from '@knowscroll/scene-core';

export interface GeometryOptions {
  readonly detail: 'full' | 'low';
  readonly reducedMotion: boolean;
}

/**
 * Silhouettes by object, rebuilt only when the descriptor or the options change, least recently
 * built first out past `limit`. A cached shape never outlives its view: the session clears it on
 * pause of the scope, authority refusal and capability change.
 */
export function createGeometryCache(limit: number) {
  const entries = new Map<string, { key: string; geometry: SceneGeometry }>();
  return {
    get(object: SceneDescriptor, options: GeometryOptions): SceneGeometry {
      const key = JSON.stringify([object, options]);
      const previous = entries.get(object.objectId);
      if (previous?.key === key) return previous.geometry;
      const geometry = buildSceneGeometry(object, options);
      entries.delete(object.objectId);
      entries.set(object.objectId, { key, geometry });
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      return geometry;
    },
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}
