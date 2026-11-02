import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ROOM_PRESENCE_BEAT_MS } from '@knowscroll/contracts';
import {
  TALK_QUERY_KEY,
  blocksRevisionKey,
  createRoom,
  createRoomActivities,
  createRoomActivity,
  createRoomDiscussion,
  createRoomFeed,
  createRoomSky,
  createRoomToday,
  readRoomList,
  readRoomTopics,
  type AccountScope,
  type RoomActivitiesController,
  type RoomActivitiesState,
  type RoomActivityController,
  type RoomActivityState,
  type RoomController,
  type RoomDiscussionController,
  type RoomDiscussionState,
  type RoomFeedController,
  type RoomFeedState,
  type RoomSkyController,
  type RoomSkyState,
  type RoomState,
  type RoomTodayController,
  type RoomTodayState,
} from '@knowscroll/client-core';
import { useMemo } from 'react';
import type { RoomTopicItem, RoomTopicSort, RoomTopicTag } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';
import { useRoomTabOpen } from './room-tab-open';

/** How often an open room or discussion asks again, in case nothing else did. */
const POLL_MS = 20_000;
/** How often Talk asks again for the person's rooms. */
const LIST_POLL_MS = 30_000;

/**
 * While a member has the room open and on screen: renew the lease that shows their face every
 * `ROOM_PRESENCE_BEAT_MS`, and listen for the room's hints so a message or a face appearing is read within seconds.
 * Another screen covering this one (a Reel or Scroll opened from the room), leaving, hiding the app or closing the tab
 * says `away`; a beat that is missed lets the lease lapse by itself.
 */
function useRoomLive(scope: AccountScope, roomId: string, controller: RoomController, open: boolean): void {
  useEffect(() => {
    if (!open) return undefined;
    const unwatch = scope.watchRoom(roomId);
    let beat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (beat !== undefined) clearInterval(beat);
      beat = undefined;
    };
    const start = () => {
      stop();
      void controller.setPresence('here');
      beat = setInterval(() => void controller.setPresence('here'), ROOM_PRESENCE_BEAT_MS);
    };
    // The state can read 'unknown' before the first change event; only an app known to be hidden holds back.
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') start();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else {
        stop();
        void controller.setPresence('away');
      }
    });
    return () => {
      subscription.remove();
      stop();
      void controller.setPresence('away');
      unwatch();
    };
  }, [scope, roomId, controller, open]);
}

/** One open room: read on mount, again on focus, on its hints and by the slow poll; a member's lease is kept while it is open. */
export function useRoom(scope: AccountScope, roomId: string): { controller: RoomController; state: RoomState } {
  const [controller] = useState(() => createRoom({ scope, roomId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  // The route stays mounted under a screen pushed on top of it, so focus is what says the room is on screen.
  const focused = useIsFocused();
  useRoomLive(scope, roomId, controller, state.phase === 'member' && focused);
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
 * The room's topics as a forum list in the order a sort asks for, optionally one tag. It reads again whenever the room is
 * read (`refreshKey` changes with each answer), so a topic that gained a reply moves with the room. While the list has not
 * arrived, or cannot, the caller shows the room's own list instead: this never says a room has no topics when it could
 * not ask.
 */
export function useRoomTopics(
  scope: AccountScope,
  roomId: string,
  query: {
    readonly sort: RoomTopicSort;
    readonly tag: RoomTopicTag | undefined;
    readonly refreshKey: unknown;
    /** Off where the list is not shown (the pinned page), so nothing is read for it. */
    readonly enabled: boolean;
    /** The list is on a tab that is not open: nothing is read until it is shown again, and the last list stays. */
    readonly paused?: boolean;
  },
): readonly RoomTopicItem[] | undefined {
  const [topics, setTopics] = useState<readonly RoomTopicItem[]>();
  const { sort, tag, refreshKey, enabled, paused = false } = query;
  useEffect(() => {
    if (!enabled || paused) return undefined;
    let current = true;
    readRoomTopics(scope, newCommandId, roomId, { sort, ...(tag === undefined ? {} : { tag }) }).then(
      (items) => {
        if (current) setTopics(items);
      },
      () => {
        if (current) setTopics(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [scope, roomId, sort, tag, refreshKey, enabled, paused]);
  return enabled ? topics : undefined;
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

/** Today's items and the member's tap: read on mount, on focus and by the slow poll, so a new day's items arrive. */
export function useRoomToday(
  scope: AccountScope,
  roomId: string,
): { controller: RoomTodayController; state: RoomTodayState } {
  const [controller] = useState(() => createRoomToday({ scope, roomId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-today', roomId),
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

/** The room's feed and what the residents remember: read on mount, on focus and by the slow poll, so a new find arrives. */
export function useRoomFeed(
  scope: AccountScope,
  roomId: string,
): { controller: RoomFeedController; state: RoomFeedState } {
  const [controller] = useState(() => createRoomFeed({ scope, roomId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  // Hidden behind another tab, or behind a discussion over the room, the feed is not read; it is read once when it is shown again.
  const open = useRoomTabOpen();
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-feed', roomId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    enabled: open,
    staleTime: 0,
    refetchInterval: open ? POLL_MS : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return { controller, state };
}

/** The room's sky for a member: read on mount, so it is only mounted while its sheet is open. */
export function useRoomSky(
  scope: AccountScope,
  roomId: string,
): { controller: RoomSkyController; state: RoomSkyState } {
  const [controller] = useState(() => createRoomSky({ scope, roomId, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-sky', roomId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    staleTime: 0,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchOnWindowFocus: true,
  });
  return { controller, state };
}
