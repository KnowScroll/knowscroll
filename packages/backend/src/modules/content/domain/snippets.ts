/**
 * Rules of snippets: anchored references into one exact, admitted content revision (blueprint §17).
 * Nothing here reads a database or a document.
 */

/** Whether a Reel range lies inside the Reel and is at least `minMs` long. */
export function reelRangeHolds(startMs: number, endMs: number, durationMs: number, minMs: number): boolean {
  return (
    Number.isSafeInteger(startMs) &&
    Number.isSafeInteger(endMs) &&
    startMs >= 0 &&
    endMs <= durationMs &&
    endMs - startMs >= minMs
  );
}
