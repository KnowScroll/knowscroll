import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  TALK_QUERY_KEY,
  createRoomLaunch,
  msUntilNextRead,
  type AccountScope,
  type RoomLaunchController,
  type RoomLaunchState,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

/** How often an open room asks about its Launch in case no hint did. */
const POLL_MS = 20_000;
/** How often a running countdown redraws: often enough that the seconds never jump, rare enough to cost nothing. */
const TICK_MS = 200;

/** A steady clock in milliseconds that never goes back and does not care what the date is: how a countdown is counted. */
export const steadyClock = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * One room's Launch for a member. It is read when the room says one is on (`enabled`), again on a room hint (the room's queries are
 * its own, so the socket's hint refreshes it), on focus and by the slow poll, and by itself the moment the phase it shows ends, so the
 * next question, its answer and the podium appear when the server's clock says they do. A device clock decides nothing.
 */
export function useRoomLaunch(
  scope: AccountScope,
  roomId: string,
  enabled: boolean,
): { controller: RoomLaunchController; state: RoomLaunchState } {
  const [controller] = useState(() => createRoomLaunch({ scope, roomId, newId: newCommandId, clock: steadyClock }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room', roomId, 'launch'),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    enabled,
    staleTime: 0,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const launch = state.view?.launch;
  useEffect(() => {
    if (!enabled) return undefined;
    const wait = msUntilNextRead(launch, steadyClock() - state.receivedAt);
    if (wait === undefined) return undefined;
    const timer = setTimeout(() => void controller.load(), wait);
    return () => clearTimeout(timer);
  }, [enabled, controller, launch, state.receivedAt]);
  // A Launch that appears or ends changes the room itself (its strip, its band, its star): the room is read again when one begins,
  // once the podium arrives and again when the star lands, without waiting for a hint, which only ever makes it quicker.
  const over =
    launch === undefined
      ? undefined
      : launch.phase === 'finished'
        ? `${launch.launchId}:${String(launch.star)}`
        : launch.launchId;
  useEffect(() => {
    if (over === undefined) return;
    void scope.queryClient.invalidateQueries({ queryKey: scope.queryKey(TALK_QUERY_KEY, 'room', roomId) });
  }, [scope, roomId, over]);
  return { controller, state };
}

/** The steady clock, redrawn while `active`, so a countdown on screen counts. */
export function useSteadyNow(active: boolean): number {
  const [now, setNow] = useState(steadyClock);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(steadyClock()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
