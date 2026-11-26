/**
 * What the fingers on the trial's stage mean, as they land, move and lift: a finger on the ship holds it, two fingers
 * pinch, one finger anywhere else turns what is in front of you. It follows each finger by its id: a pinch is two
 * particular fingers, so when one of them lifts the pinch pauses where it is, and when a finger lands again the pinch
 * goes on from there with the new pair. Measuring a new pair of fingers against the old pair's spread is what made the
 * camera jump.
 *
 * The prototype (`Universe.dc.html`, `pu`) settles a pinch as soon as one finger lifts. Here the pinch decides only once
 * the last finger is up: a stop that changed under a finger still down would take the name buttons away from under it,
 * and a browser never reports a touch again once the element it started on is gone.
 *
 * Pure: no React Native, no clock. The controller feeds it the fingers down after every touch event and acts on what it
 * returns.
 */

/** One finger on the stage, in the stage's own points; `id` is the touch's identifier. */
export interface Finger {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** A point on the stage, in points. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** What a change of fingers means. */
export type StageGesture =
  /** A finger came down on the ship: it is held there. */
  | { readonly kind: 'ship-take'; readonly at: Point }
  /** The finger holding the ship moved: the ship follows it. */
  | { readonly kind: 'ship-move'; readonly at: Point }
  /** The finger holding the ship lifted; `moved` false is a tap on the ship. */
  | { readonly kind: 'ship-let-go'; readonly moved: boolean }
  /** The hand let go of the ship without dropping it anywhere (a second finger came, or the touch was taken away). */
  | { readonly kind: 'ship-home' }
  /** One finger came down away from the ship: what is in front of you starts to turn. */
  | { readonly kind: 'turn-begin' }
  /** That finger has moved `dx`, `dy` since it came down. */
  | { readonly kind: 'turn'; readonly dx: number; readonly dy: number }
  /**
   * Two fingers are down, `spread` points apart about `between`; `resumes` when they carry on a pinch that a lifted
   * finger paused.
   */
  | { readonly kind: 'pinch-begin'; readonly spread: number; readonly between: Point; readonly resumes: boolean }
  /** The two fingers are `spread` points apart now. */
  | { readonly kind: 'pinch-move'; readonly spread: number }
  /** One of the two fingers lifted: the pinch holds where it is until a finger lands again or the last one lifts. */
  | { readonly kind: 'pinch-pause' }
  /** The last finger lifted: the pinch is over, and decides whether to move a stop. */
  | { readonly kind: 'pinch-end' }
  /** The touch was taken away mid-pinch (by the system, or a button): the pinch is over and moves nothing. */
  | { readonly kind: 'pinch-cancel' };

/** What the fingers are doing now. `paused`: a pinch under way with fewer than two fingers down; they do nothing else. */
export type TouchMode = 'idle' | 'ship' | 'turn' | 'pinch' | 'paused';

/**
 * A finger on the ship has to move this far (points) before letting go drops the ship instead of tapping it, as in the
 * prototype (`pm`: "< 6"). A finger on glass always shakes a little.
 */
const SHIP_TAP_ALLOWANCE = 6;

/** The fingers of one stage (see the top of this file). */
export interface StageTouches {
  /**
   * The fingers down now, after any finger landed, moved or lifted (none: all have lifted). `picksShip` says whether a
   * point takes the ship. `movedSoFar` is how far the first finger had already moved when the stage took the touch,
   * so a turn counts from where it came down.
   */
  update(fingers: readonly Finger[], picksShip: (at: Point) => boolean, movedSoFar?: Point): StageGesture[];
  /** The touch was taken away from the stage: everything under way stops. */
  cancel(): StageGesture[];
  mode(): TouchMode;
}

const spreadOf = (one: Point, two: Point): number => Math.hypot(one.x - two.x, one.y - two.y);

/** Makes the fingers of one stage. */
export function createStageTouches(): StageTouches {
  let mode: TouchMode = 'idle';
  /** The two fingers of the pinch under way. */
  let pair: readonly [string, string] | null = null;
  /** Where the one finger of a turn or a held ship came down. */
  let start: Point = { x: 0, y: 0 };
  let shipMoved = false;

  const beginPinch = (one: Finger, two: Finger): StageGesture => {
    const resumes = mode === 'paused';
    mode = 'pinch';
    pair = [one.id, two.id];
    return {
      kind: 'pinch-begin',
      spread: spreadOf(one, two),
      between: { x: (one.x + two.x) / 2, y: (one.y + two.y) / 2 },
      resumes,
    };
  };

  return {
    update(fingers, picksShip, movedSoFar = { x: 0, y: 0 }) {
      if (fingers.length === 0) {
        const ended: StageGesture[] =
          mode === 'ship'
            ? [{ kind: 'ship-let-go', moved: shipMoved }]
            : mode === 'pinch' || mode === 'paused'
              ? [{ kind: 'pinch-end' }]
              : [];
        mode = 'idle';
        pair = null;
        return ended;
      }
      if (fingers.length >= 2) {
        if (mode === 'pinch' && pair !== null) {
          const one = fingers.find((finger) => finger.id === pair![0]);
          const two = fingers.find((finger) => finger.id === pair![1]);
          if (one && two) return [{ kind: 'pinch-move', spread: spreadOf(one, two) }];
          mode = 'paused';
          return [{ kind: 'pinch-pause' }, beginPinch(fingers[0]!, fingers[1]!)];
        }
        const before: StageGesture[] = mode === 'ship' ? [{ kind: 'ship-home' }] : [];
        return [...before, beginPinch(fingers[0]!, fingers[1]!)];
      }
      const only = fingers[0]!;
      switch (mode) {
        case 'pinch':
          mode = 'paused';
          pair = null;
          return [{ kind: 'pinch-pause' }];
        case 'paused':
          return [];
        case 'ship':
          // The ship follows the finger at once, as the prototype's does; only letting go asks whether it was a tap.
          if (spreadOf(only, start) >= SHIP_TAP_ALLOWANCE) shipMoved = true;
          return [{ kind: 'ship-move', at: { x: only.x, y: only.y } }];
        case 'turn':
          return [{ kind: 'turn', dx: only.x - start.x, dy: only.y - start.y }];
        case 'idle': {
          start = { x: only.x - movedSoFar.x, y: only.y - movedSoFar.y };
          if (picksShip(only)) {
            mode = 'ship';
            shipMoved = false;
            return [{ kind: 'ship-take', at: { x: only.x, y: only.y } }];
          }
          mode = 'turn';
          const moved = only.x !== start.x || only.y !== start.y;
          return moved
            ? [{ kind: 'turn-begin' }, { kind: 'turn', dx: only.x - start.x, dy: only.y - start.y }]
            : [{ kind: 'turn-begin' }];
        }
      }
    },
    cancel() {
      const ended: StageGesture[] =
        mode === 'ship'
          ? [{ kind: 'ship-home' }]
          : mode === 'pinch' || mode === 'paused'
            ? [{ kind: 'pinch-cancel' }]
            : [];
      mode = 'idle';
      pair = null;
      return ended;
    },
    mode: () => mode,
  };
}
