/** `[fromMs, toMs)` since the recorder started. Always `to > from` in valid data. */
export type Interval = readonly [from: number, to: number];

/**
 * Sorts and merges overlapping or touching intervals into disjoint ones. Pure. Merging is what makes
 * a duplicate, an overlap and a retried report add nothing: unique time is the length of the union.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Total length of already-merged (disjoint) intervals. */
export function intervalsLength(merged: readonly Interval[]): number {
  let total = 0;
  for (const [from, to] of merged) total += to - from;
  return total;
}

/** The parts of both lists of already-merged intervals that overlap (two-pointer sweep). */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left === undefined || right === undefined) break;
    const from = Math.max(left[0], right[0]);
    const to = Math.min(left[1], right[1]);
    if (to > from) result.push([from, to]);
    if (left[1] < right[1]) i += 1;
    else j += 1;
  }
  return result;
}
