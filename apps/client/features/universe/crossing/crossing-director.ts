import type { CrossingDirection } from './crossing-frame';

/**
 * What a screen that plays the crossing (a visit) decides about it, as a pure state machine with no clock, no React and
 * no GL: the screen feeds it the film's time and what it knows of the other universe, and draws what it says. That keeps
 * the rules that matter testable at their boundaries: when a film is stopped, when the names in common are fixed, what a
 * skip does, what is announced and when.
 */

/** Before this film time a refusal or a lost connection stops the film (about 2.25 s of the first-time film). */
export const STOP_BEFORE_Q = 0.3;
/** The shared names are fixed at this film time (the first one starts here): a read that is not back by then adds none. */
export const NAMES_DECIDED_AT_Q = 0.47;
/** A skip lands here, as the film's own skip does; the rest of the film is its last moments. */
export const SKIP_TO_Q = 0.985;
/** The film time by which the announcement is made even if the friend's name is still unknown. */
export const ANNOUNCE_BY_Q = 0.05;
/** A reduced-motion crossing is a dark cut this long (seconds). */
export const CUT_SECONDS = 0.26;
/** What the film and the announcement call a friend whose name the read has not given yet. */
export const UNKNOWN_FRIEND = 'your friend';

/** What the screen knows of the other universe. */
export type CrossingWorld =
  /** No answer yet. */
  | { readonly status: 'waiting' }
  /** The read is back: the friend's name, and the names you have in common (undefined: nothing of yours to compare with). */
  | { readonly status: 'ready'; readonly name: string; readonly shared: readonly string[] | undefined }
  /** Not shown to you, or no connection: the screens that say so are drawn under the film. */
  | { readonly status: 'gone' };

/** What is over the screen: nothing, the film, a dark cut (reduced motion), or the white of the end fading over what is under it. */
export type CrossingMode = 'idle' | 'film' | 'cut' | 'arrival';

/** How the last crossing ended. A skipped film is a finished one the person cut short. */
export type CrossingEnd = 'finished' | 'skipped' | 'stopped';

export interface CrossingState {
  readonly mode: CrossingMode;
  readonly direction: CrossingDirection;
  /** The length of this crossing, seconds. */
  readonly seconds: number;
  /** A dark cut (reduced motion), not the film. */
  readonly cut: boolean;
  /** Film time, 0 to 1. */
  readonly q: number;
  /** A tap or Escape cut this film short: the veil is drawn over its jump. */
  readonly skipped: boolean;
  /** The friend's name once the read has given it. */
  readonly friendName: string | undefined;
  /** The names in common that drift past; fixed at {@link NAMES_DECIDED_AT_Q} and empty going home. */
  readonly names: readonly string[];
  /** The line for the screen reader, null when there is none: set once per crossing, and cleared when it is over. */
  readonly announcement: string | null;
  /** How the last crossing ended; null while one is on or before the first. */
  readonly ended: CrossingEnd | null;
  /** How many crossings have started: a new one is a new film, not the same one resumed. */
  readonly runs: number;
}

export interface CrossingStart {
  readonly direction: CrossingDirection;
  /** The film's length in seconds ({@link crossingSeconds}); ignored for a cut. */
  readonly seconds: number;
  /** Reduced motion: a dark cut instead of the film. */
  readonly cut: boolean;
}

export interface CrossingDirector {
  readonly getState: () => CrossingState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts a crossing. One already under way in the same direction goes on; going home replaces one going out. */
  readonly start: (start: CrossingStart) => void;
  /** The crossing's clock, seconds since it started. */
  readonly advance: (seconds: number) => void;
  /** A tap or Escape: to the end of the film, or the end of a cut. Nothing when nothing is playing. */
  readonly skip: () => void;
  /** What the screen now knows of the other universe. */
  readonly world: (world: CrossingWorld) => void;
  /** The white of the arrival has faded: nothing is over the screen now. */
  readonly arrived: () => void;
}

const IDLE: CrossingState = {
  mode: 'idle',
  direction: 'out',
  seconds: 0,
  cut: false,
  q: 0,
  skipped: false,
  friendName: undefined,
  names: [],
  announcement: null,
  ended: null,
  runs: 0,
};

const playing = (state: CrossingState): boolean => state.mode === 'film' || state.mode === 'cut';

/** The line a screen reader hears when the crossing starts. */
function announcementFor(direction: CrossingDirection, friendName: string | undefined): string {
  return direction === 'home' ? 'Going home' : `Going to ${friendName ?? UNKNOWN_FRIEND}’s universe`;
}

/** A director with nothing playing. It holds state: make it once per screen (`useState`), not `useMemo`. */
export function createCrossingDirector(): CrossingDirector {
  let state: CrossingState = IDLE;
  let world: CrossingWorld = { status: 'waiting' };
  /** Film seconds the last tick gave, and how far a skip moved the film ahead of the clock. */
  let clockSeconds = 0;
  let ahead = 0;
  /** Whether the names are fixed for this film. */
  let named = false;
  const listeners = new Set<() => void>();

  function set(next: CrossingState): void {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  /** The announcement: once the name is known, or by {@link ANNOUNCE_BY_Q}, and then never again in this crossing. */
  function announce(next: CrossingState): CrossingState {
    if (next.announcement !== null || !playing(next)) return next;
    if (next.direction === 'out' && next.friendName === undefined && next.q < ANNOUNCE_BY_Q && next.mode === 'film')
      return next;
    return { ...next, announcement: announcementFor(next.direction, next.friendName) };
  }

  function finish(from: CrossingState, ended: CrossingEnd, q: number): CrossingState {
    // Only the film ends in white; a cut or a stop leaves nothing over the screen.
    return { ...from, q, mode: ended === 'stopped' || from.cut ? 'idle' : 'arrival', ended };
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start({ direction, seconds, cut }) {
      if (playing(state) && state.direction === direction) return;
      // Gone before it begins: the screens that say so need no film in front of them.
      if (direction === 'out' && world.status === 'gone') return;
      clockSeconds = 0;
      ahead = 0;
      named = direction === 'home';
      set(
        announce({
          mode: cut ? 'cut' : 'film',
          direction,
          seconds: cut ? CUT_SECONDS : seconds,
          cut,
          q: 0,
          skipped: false,
          friendName: state.friendName ?? (world.status === 'ready' ? world.name : undefined),
          names: [],
          announcement: null,
          ended: null,
          runs: state.runs + 1,
        }),
      );
    },
    advance(seconds) {
      if (!playing(state)) return;
      clockSeconds = seconds;
      const q = Math.min(1, (seconds + ahead) / state.seconds);
      let next: CrossingState = { ...state, q };
      if (!named && q >= NAMES_DECIDED_AT_Q) {
        named = true;
        next = { ...next, names: world.status === 'ready' && world.shared !== undefined ? world.shared : [] };
      }
      if (q >= 1) {
        set(announce(finish(next, state.skipped ? 'skipped' : 'finished', 1)));
        return;
      }
      set(announce(next));
    },
    skip() {
      if (!playing(state)) return;
      if (state.mode === 'cut') {
        set(finish(state, 'skipped', 1));
        return;
      }
      if (state.q >= SKIP_TO_Q) return;
      ahead = Math.max(ahead, SKIP_TO_Q * state.seconds - clockSeconds);
      const next = { ...state, q: SKIP_TO_Q, skipped: true };
      // A tap before the names were fixed goes past the point they are fixed at, with none of them.
      set(announce(named ? next : { ...next, names: [] }));
      named = true;
    },
    world(next) {
      world = next;
      let updated = state;
      if (next.status === 'ready' && state.friendName !== next.name) updated = { ...updated, friendName: next.name };
      if (next.status === 'gone' && state.mode === 'film' && state.direction === 'out' && state.q < STOP_BEFORE_Q)
        updated = { ...finish(updated, 'stopped', updated.q), announcement: null };
      set(announce(updated));
    },
    arrived() {
      if (state.mode !== 'arrival') return;
      set({ ...state, mode: 'idle', announcement: null });
    },
  };
}
