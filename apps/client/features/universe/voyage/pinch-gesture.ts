/**
 * A two-finger pinch on the trial's stage, after the prototype (`zoomTo` and `settle`): the camera follows the fingers
 * as they spread or close, toward what was under them when they came down; let go past a step and it moves one stop in
 * or out, the flight leaving from where the pinch left the camera; let go short of a step and it eases back. Free of
 * touches and of three.js: the controller feeds it the fingers' spread and the driver reads `control.zoom`.
 */
import { clamp } from '../space/paint';
import type { VoyageControl } from './voyage-control';

/** A pinch has to open or close by this much to move a stop (the prototype's 1.4 and 1/1.4). */
export const PINCH_STEP = 1.4;
/** How near and how far a pinch may take the camera, as a share of its stop's distance. */
const ZOOM_RANGE = { least: 0.35, most: 3 } as const;
/** Fingers closer than this (points) count as this far apart, so the zoom never runs away (the prototype's `max(20, d)`). */
const SPREAD_FLOOR = 20;
/** A pinch that asked for a flight lets go of the camera after this long (seconds) if no flight has started. */
const HOLD_SECONDS = 0.5;

/** The pinch of one stage: see the top of this file. */
export interface PinchGesture {
  /** Two fingers came down `spread` points apart; `toward` is the place a pinch in would go to, if any. */
  begin(spread: number, toward: string | null): void;
  /** The fingers are `spread` points apart now. The camera follows them only when `live` (not under reduced motion). */
  move(spread: number, live: boolean): void;
  /**
   * The fingers lifted. Past a step, `step` is asked to move one stop and says whether it did; the zoom is then kept
   * until the flight starts ({@link targetChanged}). Otherwise the camera eases back.
   */
  end(step: (direction: 'in' | 'out') => boolean): void;
  /** A frame passed: a pinch that asked for a flight lets go of the camera if none has started by now. */
  frame(dt: number): void;
  /** The place changed: the flight has taken the camera from where the pinch left it. */
  targetChanged(): void;
  /** The gesture was taken away (by the system, or a button). */
  cancel(): void;
  /** Two fingers are down. */
  readonly pinching: () => boolean;
}

/** Makes the pinch of a stage whose camera is told through `control.zoom`. */
export function createPinchGesture(control: Pick<VoyageControl, 'zoom'>): PinchGesture {
  let pinching = false;
  let start = 0;
  let last = 0;
  let toward: string | null = null;
  let heldFor = 0;
  return {
    begin(spread, place) {
      pinching = true;
      start = spread;
      last = spread;
      toward = place;
    },
    move(spread, live) {
      last = spread;
      if (live && start > 0)
        control.zoom = {
          scale: clamp(start / Math.max(SPREAD_FLOOR, spread), ZOOM_RANGE.least, ZOOM_RANGE.most),
          toward,
        };
    },
    end(step) {
      if (!pinching) return;
      pinching = false;
      const ratio = start > 0 ? last / start : 1;
      const moved = ratio > PINCH_STEP ? step('in') : ratio < 1 / PINCH_STEP ? step('out') : false;
      heldFor = 0;
      if (!moved) control.zoom = null;
    },
    frame(dt) {
      if (pinching || control.zoom === null) return;
      heldFor += dt;
      if (heldFor > HOLD_SECONDS) control.zoom = null;
    },
    targetChanged() {
      control.zoom = null;
    },
    cancel() {
      pinching = false;
      control.zoom = null;
    },
    pinching: () => pinching,
  };
}
