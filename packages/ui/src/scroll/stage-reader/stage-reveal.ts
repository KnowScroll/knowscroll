import type { Stop } from '@knowscroll/scroll-model';
import type { CallState } from './call-state';

/**
 * The stop whose picture the stage shows while the reader is on `stop` (D-383, V3 F3). It is the stop itself, except on a Call it
 * that names a picture to turn to: once the reader has locked an answer that was wrong, the stage shows the picture of the stop that
 * call names, the true one the next stop was going to show anyway. A pick that is not locked changes nothing, and a right answer
 * keeps the picture and the flow.
 *
 * It is worked out on the device from the call's own state, and is never reported or stored: the reader's observer hears only that
 * the answer was shown, by kind, as for every call (D-063).
 */
export function pictureStopOf(stop: Stop | undefined, state: CallState | undefined): string | undefined {
  if (stop?.kind !== 'call_it' || stop.revealStage === undefined || state === undefined) return stop?.id;
  const wrong = state.revealed && state.picked !== undefined && state.picked !== stop.answer;
  return wrong ? stop.revealStage : stop.id;
}
