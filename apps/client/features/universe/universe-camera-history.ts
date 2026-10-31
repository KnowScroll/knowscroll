import type { SceneReturnLocator } from '@knowscroll/scene-core';
import type { UniverseFrame } from './universe-camera';

/** One step of where the camera has been. Private to this device; never sent anywhere. */
export interface CameraEntry {
  readonly frame: UniverseFrame;
  readonly focusId: string | null;
  readonly locator?: SceneReturnLocator;
  /** On a planet: the person has landed on its map (U04) rather than turning its globe (U03). */
  readonly landed?: boolean;
}

/** Back steps through the camera, bounded: the oldest step falls off first. */
export function createCameraHistory(limit: number) {
  let entries: CameraEntry[] = [];
  return {
    push(entry: CameraEntry) {
      entries.push({ ...entry, frame: { ...entry.frame } });
      if (entries.length > limit) entries.shift();
    },
    pop: () => entries.pop(),
    clear() {
      entries = [];
    },
    /** A copy that later pushes and pops cannot change. */
    snapshot: (): CameraEntry[] => entries.map((entry) => ({ ...entry, frame: { ...entry.frame } })),
    restore(saved: CameraEntry[]) {
      entries = saved;
    },
    size: () => entries.length,
  };
}
