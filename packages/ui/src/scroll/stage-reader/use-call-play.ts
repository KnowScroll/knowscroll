import { useState } from 'react';
import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import { FRESH_CALL, lockIn, pickOption, type CallState } from './call-state';
import { lockOf, type StagePlay } from './stage-play';
import type { StopReading } from './use-stop-reading';

/**
 * The calls of a Scroll as the reader plays them (D-063, D-135). A pick is only a pick: it is kept
 * here and reported nowhere. Locking a Call it hands the option to the play layer, which judges and
 * keeps it; locking the Final call only shows its answer here, as before (the Final call is played
 * in a later slice). Either way the reveal is reported once to the recorder, by kind, never with the
 * option. A Call it that play already holds (locked earlier, and read back) is shown revealed.
 */
export function useCallPlay(reading: StopReading, play: StagePlay, calls: readonly (CallItStop | FinalCallStop)[]) {
  const [played, setPlayed] = useState<Readonly<Record<string, CallState>>>({});
  const stateOf = (callId: string): CallState => {
    const locked = lockOf(play, callId);
    return locked === undefined ? (played[callId] ?? FRESH_CALL) : { picked: locked.option, revealed: true };
  };
  const pick = (callId: string, option: number, optionCount: number) => {
    const was = stateOf(callId);
    const next = pickOption(was, option, optionCount);
    if (next !== was) setPlayed((all) => ({ ...all, [callId]: next }));
  };
  /** Locks in and shows the answer; false when there was nothing to lock in (no pick, or already shown). */
  const lock = (callId: string): boolean => {
    const was = stateOf(callId);
    const next = lockIn(was);
    if (next === was || was.picked === undefined) return false;
    if (calls.find((call) => call.id === callId)?.kind === 'call_it') play.lock(callId, was.picked);
    else setPlayed((all) => ({ ...all, [callId]: next }));
    reading.revealed(callId);
    return true;
  };
  return { stateOf, pick, lock };
}
