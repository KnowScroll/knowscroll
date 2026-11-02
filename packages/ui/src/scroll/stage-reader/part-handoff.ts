/**
 * A swipe that moved to another Part has already shown the Part coming in under the finger, so the Part that
 * then opens must not slide in a second time. The reader that is left notes the commit; the reader that opens
 * asks whether one just happened. It is a timestamp and nothing more: it never decides a move, only whether to
 * animate one that was made.
 */
let committedAt = Number.NEGATIVE_INFINITY;

/** How long after a swipe's commit a Part that opens is taken to be the one the swipe asked for: a slow network still counts. */
const HANDOFF_WINDOW_MS = 8_000;

/** A swipe has just moved to another Part. */
export function notePartSwipeCommitted(): void {
  committedAt = Date.now();
}

/** Whether a swipe moved to another Part a moment ago, so the Part that opens has already been shown arriving. */
export function partSwipeJustCommitted(): boolean {
  return Date.now() - committedAt < HANDOFF_WINDOW_MS;
}
