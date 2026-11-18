import type { LandmarkTier } from '../model';

/** Whether a lock is kept, in the words the screen needs (the app's play session says; the reader only shows). */
export type CallKeeping =
  /** Stored on the server. */
  | 'saved'
  /** Recording is paused: nothing is stored, by choice (D-083). */
  | 'recording_paused'
  /** Not reached yet; it is sent again. */
  | 'waiting'
  /** The server will not take it. */
  | 'refused';

/** A call the person has locked: what they picked, whether it was right, and the run of right calls it ended at. */
export interface CallLock {
  readonly stopId: string;
  /** Zero-based index of the option locked. */
  readonly option: number;
  readonly correct: boolean;
  readonly combo: number;
  /** The sparks this lock earned: one for a right call, two for a right Final call after a combo of two or more (D-187). */
  readonly earned: number;
  readonly finalCall: boolean;
  readonly keeping: CallKeeping;
}

/** The landmark the Final call awarded: gold for a right answer, plain for any other (D-188). */
export interface CallLandmark {
  readonly key: string;
  readonly name: string;
  readonly tier: LandmarkTier;
}

/**
 * Play on one Scroll as the reader shows it (D-063, D-064): the calls locked, the sparks and combo
 * they earned, and a way to lock another. The app supplies one backed by its play session; without
 * one the reader keeps this on the device. None of it is evidence: the reader still reports only the
 * value-free "revealed" to the recorder.
 */
export interface CallPlay {
  /** In the order locked, those kept earlier first. */
  readonly locks: readonly CallLock[];
  /** One for each right call. Sparks belong to this Scroll alone. */
  readonly sparks: number;
  /** Right calls in a row. */
  readonly combo: number;
  /** Present once the Final call is locked, when the Scroll names a landmark. */
  readonly landmark: CallLandmark | undefined;
  /** Recording is paused: whatever is locked now stays on this device, and the screen says so. */
  readonly paused: boolean;
  /** Locks an option of a call, the Final call included. A call already locked, or an option it does not have, changes nothing. */
  readonly lock: (stopId: string, option: number) => void;
}
