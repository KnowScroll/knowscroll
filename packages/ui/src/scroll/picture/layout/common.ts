import type { PictureState, Tone } from '@knowscroll/scroll-model';
import type { PictureBox, PictureRole, TextShape } from '../scene';

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
  return {
    x: MARGIN,
    y: MARGIN,
    width: Math.max(0, box.width - 2 * MARGIN),
    height: Math.max(0, box.height - 2 * MARGIN),
  };
}

/** Whether a box is narrow enough that a row of things should become a column: a phone's figure is wider than tall. */
export const isTall = (box: PictureBox): boolean => box.width < box.height * 0.9;

/**
 * Bold letters run wider than regular ones. A layout wraps and measures every label as if it were bold, so the label of
 * a step that a state lights never wraps differently or overflows the room made for it.
 */
export const BOLD_SLACK = 1.08;

/** A label's line height as a multiple of its size. */
export const LABEL_LINE_HEIGHT = 1.2;

/** What a layout decides about one label; {@link labelShape} fills in the rest. */
export interface LabelSpec {
  readonly key: string;
  readonly part: string;
  readonly x: number;
  /** The baseline of the first line. */
  readonly y: number;
  readonly lines: readonly string[];
  readonly size: number;
  readonly bold: boolean;
  readonly anchor: TextShape['anchor'];
  readonly opacity: number;
}

/** A picture label: sans, in ink, one entry per wrapped line. */
export function labelShape(spec: LabelSpec): TextShape {
  return {
    type: 'text',
    key: spec.key,
    part: spec.part,
    x: spec.x,
    y: spec.y,
    lines: spec.lines,
    size: spec.size,
    lineHeight: spec.size * LABEL_LINE_HEIGHT,
    weight: spec.bold ? 'bold' : 'regular',
    anchor: spec.anchor,
    fill: 'ink',
    family: 'sans',
    opacity: spec.opacity,
  };
}
