/**
 * Rules of snippets: anchored references into one exact, admitted content revision (blueprint §17).
 * Nothing here reads a database or a document.
 */

/** The shortest and longest moment of a Reel that can be shared. */
export interface ReelRangeLimits {
  readonly minMs: number;
  readonly maxMs: number;
}

/** Whether a Reel range lies inside the Reel and is a moment of sensible length. */
export function reelRangeHolds(
  startMs: number,
  endMs: number,
  durationMs: number,
  limits: ReelRangeLimits,
): boolean {
  const length = endMs - startMs;
  return (
    Number.isSafeInteger(startMs) &&
    Number.isSafeInteger(endMs) &&
    startMs >= 0 &&
    endMs <= durationMs &&
    length >= limits.minMs &&
    length <= limits.maxMs
  );
}
