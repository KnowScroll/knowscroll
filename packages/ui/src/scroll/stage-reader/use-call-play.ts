import { useState } from 'react';
import { FRESH_CALL, lockIn, pickOption, type CallState } from './call-state';
import type { StopReading } from './use-stop-reading';

/**
 * The calls of a Scroll as the reader has played them, kept for the reading (not saved, not sent). A
 * lock in that shows the answer reports the reveal once, by kind (D-135); a pick reports nothing.
 */
export function useCallPlay(reading: StopReading) {
  const [played, setPlayed] = useState<Readonly<Record<string, CallState>>>({});
  const stateOf = (callId: string): CallState => played[callId] ?? FRESH_CALL;
  const pick = (callId: string, option: number, optionCount: number) =>
    setPlayed((all) => ({ ...all, [callId]: pickOption(all[callId] ?? FRESH_CALL, option, optionCount) }));
  /** Locks in and shows the answer; false when there was nothing to lock in (no pick, or already shown). */
  const lock = (callId: string): boolean => {
    const was = stateOf(callId);
    const next = lockIn(was);
    if (next === was) return false;
    setPlayed((all) => ({ ...all, [callId]: next }));
    reading.revealed(callId);
    return true;
  };
  return { stateOf, pick, lock };
}
