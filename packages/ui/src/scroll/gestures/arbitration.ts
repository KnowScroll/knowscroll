/**
 * Gesture arbitration for Scroll blocks (blueprint §18). Vertical reading comes first: a block
 * that captures a horizontal drag (a slider, scrolling code) gets it only after the horizontal
 * axis locks, and then owns it until release; a block that captures both axes (dragging a token
 * onto a target) owns the touch from the start, because the token is a small, deliberate handle.
 * Blocks that declare `none` never take a drag, so the article keeps every vertical movement.
 *
 * One rule, two implementations: native gives these numbers to react-native-gesture-handler
 * (`activeOffsetX`, `failOffsetY`: the pan activates after `AXIS_SLOP` horizontally and fails if
 * it moves `AXIS_SLOP` vertically first, which hands the touch back to the vertical scroll), and
 * the web applies `classifyMove` to pointer events (with `touch-action: pan-y`, so the browser
 * itself keeps vertical panning on touch screens).
 */

/** Distance, in px, a touch must travel before its direction counts. */
export const AXIS_SLOP = 10;

export type Axis = 'undecided' | 'horizontal' | 'vertical';

/** Which axis a movement from the touch-down point belongs to, once it has travelled past the slop. */
export function classifyMove(dx: number, dy: number): Axis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_SLOP) return 'undecided';
  return Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
}

/** What react-native-gesture-handler gets for a horizontal capture (a slider). */
export const HORIZONTAL_PAN = {
  activeOffsetX: [-AXIS_SLOP, AXIS_SLOP],
  failOffsetY: [-AXIS_SLOP, AXIS_SLOP],
} as const satisfies { activeOffsetX: [number, number]; failOffsetY: [number, number] };

/** What it gets for a two-axis capture (a draggable token): active almost at once, in any direction. */
export const TWO_AXIS_PAN = { minDistance: 2 } as const;
