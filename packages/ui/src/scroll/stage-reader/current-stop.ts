/**
 * Which section of the text the reader is on: the last one whose top has passed the reading line (a
 * share of the way down the visible text). At the very end of the text it is the last section, so
 * the end tray can be reached even when it is short. Pure; `tops` are the sections' offsets from
 * the top of the content, in order.
 */
export function currentSection(input: {
  readonly tops: readonly number[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}): number {
  const { tops, scrollTop, viewportHeight, contentHeight } = input;
  if (tops.length === 0) return 0;
  if (contentHeight > viewportHeight && scrollTop + viewportHeight >= contentHeight - 2) return tops.length - 1;
  const line = scrollTop + viewportHeight * READING_LINE;
  let current = 0;
  tops.forEach((top, index) => {
    if (top <= line) current = index;
  });
  return current;
}

/** How near the end, in px, still counts as at it. */
export const END_SLACK = 4;

/** Whether text that scrolls is scrolled to its very end; text that fits has no end to be at. */
export function scrolledToEnd(input: {
  readonly scrollTop: number;
  readonly viewport: number;
  readonly content: number;
}): boolean {
  return input.content > input.viewport && input.scrollTop + input.viewport >= input.content - END_SLACK;
}

/** Where the reading line sits in the visible text, from its top. */
export const READING_LINE = 0.4;

/** How near to a stop's top, in px, a stopped scroll is moved the last way onto it. */
export const SNAP_PROXIMITY = 48;

/**
 * The top a scroll that has stopped at `scrollTop` should settle on, or `undefined` to stay: the
 * nearest stop top within {@link SNAP_PROXIMITY}, unless the reader is at the very end of the text.
 */
export function settleTarget(input: {
  readonly tops: readonly number[];
  readonly scrollTop: number;
  readonly atEnd: boolean;
}): number | undefined {
  if (input.atEnd) return undefined;
  let nearest: number | undefined;
  for (const top of input.tops) {
    const distance = Math.abs(top - input.scrollTop);
    if (distance === 0) return undefined;
    if (distance <= SNAP_PROXIMITY && (nearest === undefined || distance < Math.abs(nearest - input.scrollTop)))
      nearest = top;
  }
  return nearest;
}
