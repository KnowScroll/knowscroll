import type { AccountScope } from '@knowscroll/client-core';
import type { UniverseFrame } from './universe-camera';
import {
  isAbsent,
  loadUniverseMemory,
  saveUniverseMemory,
  type LastPlace,
  type UniverseMemory,
} from './universe-memory';

/** What the view tells memory to keep. */
export interface RememberedView {
  readonly focusId: string | null;
  readonly landed: boolean;
  readonly frame: UniverseFrame;
  readonly lately: boolean;
  readonly lastPlace: LastPlace | undefined;
}
export interface Restored {
  readonly camera: { readonly focusId: string; readonly frame: UniverseFrame; readonly landed: boolean } | undefined;
  readonly lastPlace: LastPlace | undefined;
  readonly absent: boolean;
}

/**
 * The device memory of one Universe view (camera, Lately, ship), written on a trailing timer while
 * the camera moves and at once on a choice.
 *
 * Nothing is written before the remembered state has been restored: a view that has not yet seen
 * its map would otherwise overwrite where the person left it, and a long absence could never show.
 */
export function createDeviceMemory(scope: AccountScope, now: () => number, live: () => boolean) {
  const remembered = loadUniverseMemory(scope);
  let restored = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: (() => RememberedView) | undefined;
  const writable = () => live() && (!remembered || restored);
  const write = () => {
    timer = undefined;
    if (!writable() || !latest) return;
    const view = latest();
    saveUniverseMemory(scope, {
      focusId: view.focusId,
      landed: view.landed,
      frame: view.frame,
      lately: view.lately,
      lastPlace: view.lastPlace,
      seenAt: now(),
    } satisfies UniverseMemory);
  };
  return {
    lately: remembered?.lately ?? false,
    lastPlace: remembered?.lastPlace,
    /** Who supplies the current view when a write happens. */
    keep(view: () => RememberedView) {
      latest = view;
    },
    saveNow() {
      clearTimeout(timer);
      write();
    },
    saveSoon() {
      clearTimeout(timer);
      timer = setTimeout(write, 500);
    },
    /**
     * Once, when the first map is on hand: where the camera goes back to, or, after a long absence,
     * nothing (framed on everything) with the ship still parked. `hasPlace` says whether a place
     * still exists; a place that is gone is forgotten.
     */
    restore(hasPlace: (id: string) => boolean): Restored | undefined {
      if (restored) return undefined;
      restored = true;
      if (!remembered) return undefined;
      const absent = isAbsent(remembered, now());
      const lastPlace = remembered.lastPlace && hasPlace(remembered.lastPlace.id) ? remembered.lastPlace : undefined;
      const focusId = remembered.focusId;
      const back = !absent && focusId !== null && hasPlace(focusId);
      return {
        camera: back ? { focusId, frame: remembered.frame, landed: remembered.landed } : undefined,
        lastPlace,
        absent: absent && lastPlace !== undefined,
      };
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
