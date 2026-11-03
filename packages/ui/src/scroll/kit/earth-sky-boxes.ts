import { SCENE_HEIGHT, SCENE_WIDTH } from './earth-sky-scene';

/**
 * The boxes the Earth & sky pictures are laid out with: a line of mono text and the room an Earth takes, as rectangles in the
 * 320 × 200 frame. Every label and mark is placed from the scene alone, so a test can check each one against the frame and
 * against the others without drawing anything.
 */

export type Anchor = 'start' | 'middle' | 'end';

/** A line of mono text at 8.5 px, anchored at its start, middle or end. */
export interface SceneLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: Anchor;
}

/** The mono face at 8.5 px is about this many frame units a character (the layout tests keep a margin). */
export const LABEL_CHARACTER_PX = 5.4;
const LABEL_HEIGHT = 9.5;

export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** The box a label takes, estimated from its text. */
export function labelBox(label: SceneLabel): Box {
  const width = label.text.length * LABEL_CHARACTER_PX;
  const left = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - width : label.x - width / 2;
  return { left, right: left + width, top: label.y - 8, bottom: label.y - 8 + LABEL_HEIGHT };
}

/** Two boxes share some area. */
export const boxesOverlap = (first: Box, second: Box): boolean =>
  first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;

/** The box with `by` more room on every side. */
export const inflate = (box: Box, by: number): Box => ({
  left: box.left - by,
  right: box.right + by,
  top: box.top - by,
  bottom: box.bottom + by,
});

/** The phone's TEXT pill covers the lower right corner of the frame, from this x and y on. */
export const TEXT_PILL = { left: 272, top: 186 } as const;

/** A box sits inside the frame and clear of the TEXT pill. */
export function fitsFrame(box: Box): boolean {
  return (
    box.left >= 2 &&
    box.right <= SCENE_WIDTH - 2 &&
    box.top >= 0 &&
    box.bottom <= SCENE_HEIGHT &&
    !(box.right > TEXT_PILL.left && box.bottom > TEXT_PILL.top)
  );
}

/** The first label that fits the frame and covers none of the boxes; with none, the first (the layout tests would say so). */
export function firstFree(candidates: readonly SceneLabel[], obstacles: readonly Box[]): SceneLabel {
  const free = candidates.find((candidate) => {
    const box = labelBox(candidate);
    return fitsFrame(box) && obstacles.every((other) => !boxesOverlap(box, other));
  });
  return free ?? candidates[0]!;
}
