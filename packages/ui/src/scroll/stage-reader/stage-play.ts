import { useCallback, useState } from 'react';
import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import { talliesAfterEach } from '../model';

/** Whether a lock is kept, in the words the screen needs (the app's play session says; the reader only shows). */
export type StageKeeping =
  /** Stored on the server. */
  | 'saved'
  /** Not stored anywhere: the reader's own play when the app gives it none. */
  | 'device_only'
  /** Recording is paused: nothing is stored, by choice (D-083). */
  | 'recording_paused'
  /** Not reached yet; it is sent again. */
  | 'waiting'
  /** The server will not take it. */
  | 'refused';

/** A Call it the person has locked: what they picked, whether it was right, and the run of right calls it ended at. */
export interface StageLock {
  readonly stopId: string;
  /** Zero-based index of the option locked. */
  readonly option: number;
  readonly correct: boolean;
  readonly combo: number;
  readonly keeping: StageKeeping;
}

/**
 * Play on one Scroll as the reader shows it (D-063, D-064): the calls locked, the sparks and combo
 * they earned, and a way to lock another. The app supplies one backed by its play session; without
 * one the reader keeps this on the device. None of it is evidence: the reader still reports only the
 * value-free "revealed" to the recorder.
 */
export interface StagePlay {
  /** In the order locked, those kept earlier first. */
  readonly locks: readonly StageLock[];
  /** One for each right call. Sparks belong to this Scroll alone. */
  readonly sparks: number;
  /** Right calls in a row. */
  readonly combo: number;
  /** Recording is paused: whatever is locked now stays on this device, and the screen says so. */
  readonly paused: boolean;
  /** Locks an option of a Call it. A call already locked, or an option it does not have, changes nothing. */
  readonly lock: (stopId: string, option: number) => void;
}

export function lockOf(play: StagePlay, stopId: string): StageLock | undefined {
  return play.locks.find((lock) => lock.stopId === stopId);
}

/**
 * The reader's own play when the app gives it none (the gallery, tests): locks judged from the
 * document and kept in memory. Nothing is sent and nothing survives the screen.
 */
export function useLocalStagePlay(calls: readonly (CallItStop | FinalCallStop)[]): StagePlay {
  const [picks, setPicks] = useState<
    readonly { readonly stopId: string; readonly option: number; readonly correct: boolean }[]
  >([]);
  const lock = useCallback(
    (stopId: string, option: number) => {
      const call = calls.find((candidate) => candidate.kind === 'call_it' && candidate.id === stopId);
      if (call === undefined || !Number.isInteger(option) || option < 0 || option >= call.options.length) return;
      setPicks((all) =>
        all.some((pick) => pick.stopId === stopId)
          ? all
          : [...all, { stopId, option, correct: option === call.answer }],
      );
    },
    [calls],
  );
  const tallies = talliesAfterEach(picks);
  return {
    locks: picks.map((pick, index) => ({ ...pick, combo: tallies[index]!.combo, keeping: 'device_only' })),
    sparks: tallies.at(-1)?.sparks ?? 0,
    combo: tallies.at(-1)?.combo ?? 0,
    paused: false,
    lock,
  };
}
