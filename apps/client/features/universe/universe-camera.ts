import { SceneReturnLocatorSchema, type SceneReturnLocator } from '@knowscroll/scene-core';

/**
 * The camera of one view, relative to the way that view first draws itself: `x`/`y` pan in screen
 * pixels and `scale` zooms about the centre of the view. A fresh frame therefore always shows the
 * whole view, whatever the screen size.
 */
export type UniverseFrame = SceneReturnLocator['frame'];
export const INITIAL_FRAME: UniverseFrame = { x: 0, y: 0, scale: 1 };
/** Silhouettes kept and Back steps kept. */
export const DRAW_LIMITS = { cache: 128, history: 32 } as const;
const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
export function boundedFrame(f: UniverseFrame): UniverseFrame {
  return {
    x: Math.max(-10000, Math.min(10000, finite(f.x, 0))),
    y: Math.max(-10000, Math.min(10000, finite(f.y, 0))),
    scale: Math.max(0.125, Math.min(16, finite(f.scale, 1))),
  };
}
export function returnLocator(chunkId: string, objectId: string, frame: UniverseFrame): SceneReturnLocator {
  return SceneReturnLocatorSchema.parse({
    schemaVersion: 'scene-return.v1',
    chunkId,
    objectId,
    frame: boundedFrame(frame),
  });
}
