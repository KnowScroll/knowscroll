/**
 * A pull up past the end of the essay asks for the next topic (D-134, kept by D-425): the touch twin of Next idea and the
 * N key. It counts only when the page was already at its very end as the finger went down, so a fling that runs into the
 * end is still reading, and only once it has travelled further than a fling carries.
 */

/** How far a finger travels up for a release to move on. */
export const PULL_DISTANCE = 96;
/** Each screen edge belongs to the platform's Back gesture. */
const EDGE_ZONE = 24;
/** How close to its end the page counts as at its end: a scroll position can stop a pixel or two short. */
const END_SLACK = 4;

/** Where a finger went down, and whether the page was then at its very end. */
export interface PullStart {
  readonly x: number;
  readonly y: number;
  readonly atEnd: boolean;
  readonly screenWidth: number;
}

/** Whether a page is scrolled to its very end; a page that fits its viewport has no end to pull past. */
export function atVeryEnd(scrollTop: number, viewport: number, content: number): boolean {
  return content > viewport && scrollTop + viewport >= content - END_SLACK;
}

/**
 * How far a pull has got with the finger now at `x`, `y`: from 0 to 1, where 1 is the distance a release needs. It is 0
 * for a drag that is not a pull: one that began short of the end or at a screen edge, went down, or went mostly sideways.
 */
export function pullProgress(start: PullStart, x: number, y: number): number {
  if (!start.atEnd || start.x < EDGE_ZONE || start.x > start.screenWidth - EDGE_ZONE) return 0;
  const dx = x - start.x;
  const dy = y - start.y;
  if (dy >= 0 || Math.abs(dy) < Math.abs(dx) * 1.5) return 0;
  return Math.min(1, -dy / PULL_DISTANCE);
}
