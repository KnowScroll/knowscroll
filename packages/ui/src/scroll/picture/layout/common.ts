import type { PictureState, Tone } from '@knowscroll/scroll-model';
import type { PictureBox, PictureRole } from '../scene';

/** How faint an item is drawn while other items of the picture are lit: present, and plainly not the subject. */
export const RECEDED = 0.4;

/** The room every layout leaves inside the box's edges, in pixels. */
export const MARGIN = 12;

/** The role an item's tone is drawn in; an item without one is ink. */
export function toneRole(tone: Tone | undefined): PictureRole {
  return tone ?? 'ink';
}

/**
 * How strongly to draw item `id`: 0 when `upTo` has not reached it yet (it is still in the scene, so it fades in when a
 * later state reaches it), RECEDED when other items are lit, else 1.
 */
export function itemOpacity(state: PictureState, id: string, index?: number): number {
  if (state.upTo !== undefined && index !== undefined && index >= state.upTo) return 0;
  if (state.lit !== undefined && !state.lit.includes(id)) return RECEDED;
  return 1;
}

/** Whether item `id` is one the state lights. */
export const isLit = (state: PictureState, id: string): boolean => state.lit?.includes(id) === true;

/** The inner box a layout draws in, after the margin. */
export function inner(box: PictureBox): { x: number; y: number; width: number; height: number } {
  return { x: MARGIN, y: MARGIN, width: Math.max(0, box.width - 2 * MARGIN), height: Math.max(0, box.height - 2 * MARGIN) };
}

/** Whether a box is narrow enough that a row of things should become a column: a phone's figure is wider than tall. */
export const isTall = (box: PictureBox): boolean => box.width < box.height * 0.9;
