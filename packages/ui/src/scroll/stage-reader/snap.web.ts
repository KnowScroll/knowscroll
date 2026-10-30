/**
 * Web: the browser's own CSS snapping picked the wrong place after a programmatic scroll to the end
 * of a long last section (it pulled the text back to the first stop), so the reader settles on a stop
 * itself, softly: when scrolling has stopped near a stop's top it moves the last few pixels, and
 * anywhere else it leaves the text where the reader put it.
 */
export function snapProps(_offsets: readonly number[]): Record<string, unknown> {
  return {};
}

export const SNAPS_IN_SCRIPT = true;
