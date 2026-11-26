/**
 * A two-finger pinch on the trial's stage, after the prototype (`zoomTo` and `settle`): the camera follows the fingers
 * as they spread or close, toward what was under them when they came down; let go past a step and it moves one stop in
 * or out, the flight leaving from where the pinch left the camera; let go short of a step and it eases back. Fingers
 * that come down during a flight hold the camera, so the driver hurries the flight to its stop and then eases the camera
 * to where the fingers have taken it; the whole pinch counts, flight or not. Free of touches and of three.js: the
 * controller feeds it the fingers' spread and the driver reads `control.zoom`.
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

/** What letting go did: moved a stop in or out, eased back short of a step, or found no stop to move to. */
export type PinchOutcome = 'in' | 'out' | 'back' | 'nowhere';

/** The pinch of one stage: see the top of this file. */
export interface PinchGesture {
  /**
   * Two fingers came down `spread` points apart; `toward` is the place a pinch in would go to, if any. If a pinch is
   * already under way (one of its fingers lifted and a finger landed again), it carries on from where it was, toward the
   * same place.
   */
  begin(spread: number, toward: string | null): void;
  /** The fingers are `spread` points apart now. The camera follows them only when `live` (not under reduced motion). */
  move(spread: number, live: boolean): void;
  /**
   * The last finger lifted. Past a step, `step` is asked to move one stop and says whether it did; the zoom is then kept
   * until the flight starts ({@link targetChanged}). Otherwise the camera eases back.
   */
  end(step: (direction: 'in' | 'out') => boolean): PinchOutcome;
  /**
   * A frame passed, `flying` if a flight was under way in it. Fingers that pinch during a flight hold the camera even
   * before they move, so the driver hurries the flight. A pinch that asked for a flight lets go of the camera if none has
   * started by now.
   */
  frame(dt: number, flying: boolean): void;
  /** The place changed: the flight has taken the camera from where the pinch left it. */
  targetChanged(): void;
  /** The gesture was taken away (by the system, or a button). */
  cancel(): void;
  /** A pinch is under way: from the first two fingers down to the last finger up. */
  readonly pinching: () => boolean;
  /** How far the fingers have spread (more than 1) or closed since the pinch began, across every pair of fingers it had. */
  readonly ratio: () => number;
}

/** Makes the pinch of a stage whose camera is told through `control.zoom`. */
export function createPinchGesture(control: Pick<VoyageControl, 'zoom'>): PinchGesture {
  let pinching = false;
  /** The spread of the fingers down now when they came down, and their spread now. */
  let start = 0;
  let last = 0;
  /** What the earlier pairs of fingers of this pinch did, as a ratio: 1 until a finger lifts and lands again. */
  let carried = 1;
  let toward: string | null = null;
  let heldFor = 0;
  const ratio = () => carried * (start > 0 ? last / start : 1);
  /** The camera's distance as a share of its stop's, for the fingers' spread now. */
  const scaleFor = (spread: number) =>
    clamp(start / (carried * Math.max(SPREAD_FLOOR, spread)), ZOOM_RANGE.least, ZOOM_RANGE.most);
  return {
    begin(spread, place) {
      if (pinching) carried = ratio();
      else {
        carried = 1;
        toward = place;
      }
      pinching = true;
      start = spread;
      last = spread;
    },
    move(spread, live) {
      last = spread;
      if (live && start > 0) control.zoom = { scale: scaleFor(spread), toward };
    },
    end(step) {
      if (!pinching) return 'back';
      pinching = false;
      const spreadBy = ratio();
      const direction = spreadBy > PINCH_STEP ? 'in' : spreadBy < 1 / PINCH_STEP ? 'out' : null;
      const moved = direction !== null && step(direction);
      heldFor = 0;
      if (!moved) control.zoom = null;
      return moved ? direction : direction === null ? 'back' : 'nowhere';
    },
    frame(dt, flying) {
      if (pinching && flying && control.zoom === null && start > 0) {
        control.zoom = { scale: scaleFor(last), toward };
        return;
      }
      if (pinching || control.zoom === null) return;
      heldFor += dt;
      if (heldFor > HOLD_SECONDS) control.zoom = null;
    },
    targetChanged() {
      control.zoom = null;
    },
    cancel() {
      pinching = false;
      carried = 1;
      control.zoom = null;
    },
    pinching: () => pinching,
    ratio,
  };
}
