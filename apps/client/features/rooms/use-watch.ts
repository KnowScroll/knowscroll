import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  TALK_QUERY_KEY,
  createRoomWatch,
  msUntilNextWatchRead,
  type AccountScope,
  type RoomWatchController,
  type RoomWatchState,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { steadyClock } from './use-launch';

/** How often an open room asks about its stage in case no hint did: the longest a lost hint can cost. */
const POLL_MS = 20_000;

/**
 * One room's Watch together stage for a member. It is read when the room says a Reel can be watched or one is on (`enabled`), again on a
 * room hint (the room's queries are its own, so the socket's hint refreshes it), on focus and reconnect, by the slow poll, and by itself
 * the moment the phase it shows ends. A dropped socket costs a few seconds at most, because every read is the whole truth: the session,
 * whether this person joined, and the time on the server's clock. A device clock decides nothing.
 */
export function useRoomWatch(
  scope: AccountScope,
  roomId: string,
  enabled: boolean,
): { controller: RoomWatchController; state: RoomWatchState } {
  const [controller] = useState(() => createRoomWatch({ scope, roomId, newId: newCommandId, clock: steadyClock }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room', roomId, 'watch'),
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
  const session = state.view?.session;
  useEffect(() => {
    if (!enabled) return undefined;
    const wait = msUntilNextWatchRead(session, steadyClock() - state.receivedAt);
    if (wait === undefined) return undefined;
    const timer = setTimeout(() => void controller.load(), wait);
    return () => clearTimeout(timer);
  }, [enabled, controller, session, state.receivedAt]);
  // A session that begins or ends changes the room itself (its strip, its band, its station): the room is read again, without waiting
  // for a hint, which only ever makes it quicker.
  const sessionId = session?.sessionId;
  const known = useRef<{ readonly sessionId: string | undefined } | undefined>(undefined);
  const read = state.phase === 'ready';
  useEffect(() => {
    if (!read) return;
    const changed = known.current !== undefined && known.current.sessionId !== sessionId;
    known.current = { sessionId };
    if (changed) void scope.queryClient.invalidateQueries({ queryKey: scope.queryKey(TALK_QUERY_KEY, 'room', roomId) });
  }, [scope, roomId, sessionId, read]);
  return { controller, state };
}
