import { callsOf, type CallItStop, type ScrollDocumentV2 } from '@knowscroll/scroll-model';

/**
 * The puzzle that fills the wait (D1 "After send"): a Call it of the Scroll the person asked from that they have not
 * played. It is the Scroll's own call, so nothing is invented and nothing new is judged: locking it is the same lock a
 * reader makes, kept by the play layer under its own rules (D-063, D-083), and no evidence. A call at or before the stop
 * they asked from comes first, because they have read it; failing that the next one that waits. The Final call is never
 * the puzzle: it has its own way in. None left, and there is no puzzle: the wait card stands alone.
 */
export function pickPuzzle(
  document: Pick<ScrollDocumentV2, 'stops'>,
  lockedStopIds: ReadonlySet<string>,
  anchorStopId: string,
): CallItStop | undefined {
  const unplayed = callsOf(document).filter(
    (call): call is CallItStop => call.kind === 'call_it' && !lockedStopIds.has(call.id),
  );
  const order = new Map(document.stops.map((stop, index) => [stop.id, index]));
  const anchorAt = order.get(anchorStopId) ?? document.stops.length;
  const read = unplayed.filter((call) => (order.get(call.id) ?? Infinity) <= anchorAt);
  // The latest call they have already read is the freshest in their mind; otherwise the next one ahead.
  return read.at(-1) ?? unplayed[0];
}
