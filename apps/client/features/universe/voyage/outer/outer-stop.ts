import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * Whether the person is at the outer stop (past the rim of their universe, among their friends'), and whether the list
 * of every friend is open over it. A device-only flag held in memory for one signed-in Universe screen: nothing about it
 * is stored, not in the stored camera, not in the scene-return key, not in the session. It is made once per screen
 * (`createOuterStop`) and handed down by {@link OuterStopContext}; a friend's Universe and the gallery have no provider,
 * so there is no outer stop there at all, and with the trial off the provider holds null.
 */
export interface OuterStopState {
  readonly on: boolean;
  /** The list of every friend is open. Never true while `on` is false. */
  readonly listOpen: boolean;
}

export interface OuterStop {
  /** The same object until something changes, so a React subscription never renders for nothing. */
  readonly getState: () => OuterStopState;
  /** Go past the rim. */
  readonly enter: () => void;
  /** Come back to the universe; closes the list with it. */
  readonly leave: () => void;
  readonly openList: () => void;
  readonly closeList: () => void;
  /** Calls `listener` after each change; returns the way to stop. */
  readonly subscribe: (listener: () => void) => () => void;
}

const AWAY: OuterStopState = { on: false, listOpen: false };

/** Makes the flag of one screen: at rest, not past the rim, no list. */
export function createOuterStop(): OuterStop {
  let state = AWAY;
  const listeners = new Set<() => void>();
  const set = (next: OuterStopState) => {
    if (next.on === state.on && next.listOpen === state.listOpen) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    enter: () => set({ on: true, listOpen: false }),
    leave: () => set(AWAY),
    openList: () => set(state.on ? { on: true, listOpen: true } : state),
    closeList: () => set({ on: state.on, listOpen: false }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The outer stop of the signed-in Universe screen this is under; null for a visit, the gallery, or with the trial off. */
export const OuterStopContext = createContext<OuterStop | null>(null);

/** The screen's outer stop, or null: every branch the outer stop adds checks for it. */
export const useOuterStop = (): OuterStop | null => useContext(OuterStopContext);

const noop = () => () => undefined;
const getAway = () => AWAY;

/** Where the person is at the outer stop, re-rendering on a change; at rest (away) when there is none. */
export function useOuterStopState(outer: OuterStop | null): OuterStopState {
  return useSyncExternalStore(outer?.subscribe ?? noop, outer?.getState ?? getAway, getAway);
}
