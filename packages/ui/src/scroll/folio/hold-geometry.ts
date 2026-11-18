/**
 * Where the reading line sits in the viewport: a little below the figure a hold pins, so a held beat takes the figure
 * once its first line is in clear view under it. A fraction of the room left under the figure.
 */
const LINE_BELOW_FIGURE = 0.3;

/** The reading line, in px from the top of the viewport, for a figure `figureHeight` tall pinned at the top. */
export function readingLineOf(viewportHeight: number, figureHeight: number): number {
  return figureHeight + Math.max(0, viewportHeight - figureHeight) * LINE_BELOW_FIGURE;
}

/**
 * Which beat of a hold its figure shows: the last one whose top has reached the reading line, and the first until any
 * has. `beatTops` and `line` are in the scroll content's coordinates. Pure.
 */
export function heldBeatAt(beatTops: readonly number[], line: number): number {
  let shown = 0;
  beatTops.forEach((top, index) => {
    if (top <= line) shown = index;
  });
  return shown;
}
