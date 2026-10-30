/** Native: a soft stop per screen through the scroll view's own snap offsets. */
export function snapProps(offsets: readonly number[]): Record<string, unknown> {
  return { snapToOffsets: [...offsets], snapToEnd: false, decelerationRate: 'fast' };
}

/** Whether the reader settles on a stop itself when scrolling stops (the web, which has no snap offsets). */
export const SNAPS_IN_SCRIPT = false;
