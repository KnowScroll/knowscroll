import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  TALK_QUERY_KEY,
  blocksRevisionKey,
  createRoom,
  createRoomActivities,
  createRoomActivity,
  createRoomDiscussion,
  readRoomList,
  type AccountScope,
  type RoomActivitiesController,
  type RoomActivitiesState,
  type RoomActivityController,
  type RoomActivityState,
  type RoomController,
  type RoomDiscussionController,
  type RoomDiscussionState,
  type RoomState,
} from '@knowscroll/client-core';
import { useMemo } from 'react';
import { newCommandId } from '../../platform/command-id';

/** How often an open room or discussion asks again, in case nothing else did. */
const POLL_MS = 20_000;
/** How often Talk asks again for the person's rooms. */
const LIST_POLL_MS = 30_000;

/** One open room: read on mount, again on focus, and by the slow poll. */
export function useRoom(scope: AccountScope, roomId: string): { controller: RoomController; state: RoomState } {
  const [controller] = useState(() => createRoom({ scope, roomId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room', roomId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    staleTime: 0,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return { controller, state };
}

/**
 * One open room discussion. The controller holds it; this hook starts it and keeps it fresh: the
 * first run reads the discussion, every later run catches up from the last confirmed position,
 * whether a focus or reconnect, the slow poll, or the app returning to the foreground asked for it.
 */
export function useRoomDiscussion(
  scope: AccountScope,
  roomId: string,
  discussionId: string,
): { controller: RoomDiscussionController; state: RoomDiscussionState } {
  const [controller] = useState(() => createRoomDiscussion({ scope, roomId, discussionId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-discussion', discussionId),
    queryFn: async () => {
      await controller.refresh();
      return Date.now();
    },
    staleTime: 0,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void controller.refresh();
    });
    return () => subscription.remove();
  }, [controller]);
  // A block or unblock changes what this discussion shows without giving any message a new change number, so
  // catching up would never carry it: read the whole discussion afresh, here and now, without a remount.
  const blocks = useQuery({
    queryKey: blocksRevisionKey(scope),
    queryFn: () => 0,
    initialData: 0,
    staleTime: Infinity,
  }).data;
  const blocksSeen = useRef(blocks);
  useEffect(() => {
    if (blocks === blocksSeen.current) return;
    blocksSeen.current = blocks;
    void controller.resnapshot();
  }, [blocks, controller]);
  return { controller, state };
}

/** The person's rooms under the scope's Talk key, so a focus and a reconnect refresh them with the rest of Talk. */
export function useRoomList(scope: AccountScope | undefined) {
  const key = useMemo(
    () =>
      scope === undefined
        ? ([TALK_QUERY_KEY, 'signed-out', 'rooms'] as const)
        : scope.queryKey(TALK_QUERY_KEY, 'rooms'),
    [scope],
  );
  const query = useQuery({
    queryKey: key,
    enabled: scope !== undefined,
    queryFn: () => {
      if (scope === undefined) throw new Error('no scope');
      return readRoomList(scope, newCommandId);
    },
    refetchInterval: LIST_POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return {
    items: query.data ?? [],
    loading: query.isPending && scope !== undefined,
    failed: query.isError,
    retry: () => void query.refetch(),
  };
}

/** How often a room's activities are read again; a poll's tally is read more often than the list of them. */
const ACTIVITY_POLL_MS = 15_000;

/** One room's activities (R03): read on mount, again on focus, and by the slow poll. */
export function useRoomActivities(
  scope: AccountScope,
  roomId: string,
): { controller: RoomActivitiesController; state: RoomActivitiesState } {
  const [controller] = useState(() => createRoomActivities({ scope, roomId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-activities', roomId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    staleTime: 0,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return { controller, state };
}

/** One poll or quiz. A quiz is served whole and never read again; a poll's tally is. */
export function useRoomActivity(
  scope: AccountScope,
  roomId: string,
  activityId: string,
): { controller: RoomActivityController; state: RoomActivityState } {
  const [controller] = useState(() => createRoomActivity({ scope, roomId, activityId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const quiz = state.view?.activity.kind === 'quiz';
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-activity', activityId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    staleTime: 0,
    refetchInterval: quiz ? false : ACTIVITY_POLL_MS,
    refetchOnWindowFocus: !quiz,
    refetchOnReconnect: !quiz,
  });
  return { controller, state };
}
