import { SceneReturnLocatorSchema, type SceneDescriptor, type SceneReturnLocator } from '@knowscroll/scene-core';
export type UniverseFrame = SceneReturnLocator['frame'];
export const INITIAL_FRAME: UniverseFrame = { x: 0, y: 0, scale: 1 };
export const DRAW_LIMITS = { bodies: 64, routes: 64, labels: 32, cache: 128, history: 32 } as const;
const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
export function boundedFrame(f: UniverseFrame): UniverseFrame {
  return {
    x: Math.max(-10000, Math.min(10000, finite(f.x, 0))),
    y: Math.max(-10000, Math.min(10000, finite(f.y, 0))),
    scale: Math.max(0.125, Math.min(16, finite(f.scale, 1))),
  };
}
/** One transform, never a layout inferred from sibling order or activity. */
export function projectPoint(p: { x: number; y: number }, f: UniverseFrame) {
  return { x: 500 + (p.x - f.x) * f.scale, y: 300 + (p.y - f.y) * f.scale };
}
export function fitFrame(objects: readonly SceneDescriptor[]): UniverseFrame {
  if (!objects.length) return { ...INITIAL_FRAME };
  const xs = objects.map((o) => o.anchor.x),
    ys = objects.map((o) => o.anchor.y);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  return boundedFrame({
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    scale: Math.min(2, 900 / (right - left + 180), 500 / (bottom - top + 180)),
  });
}
export function returnLocator(chunkId: string, objectId: string, frame: UniverseFrame): SceneReturnLocator {
  return SceneReturnLocatorSchema.parse({
    schemaVersion: 'scene-return.v1',
    chunkId,
    objectId,
    frame: boundedFrame(frame),
  });
}
