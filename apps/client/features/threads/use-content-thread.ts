import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  TALK_QUERY_KEY,
  createContentThread,
  type AccountScope,
  type ContentThreadController,
  type ContentThreadState,
} from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/** How often an open thread asks again, in case a live hint was lost. */
const POLL_MS = 20_000;

/**
 * One open thread. The controller holds it; this hook starts it and keeps it fresh: the first run
 * reads the thread, every later run catches up from the last confirmed position, whether a live
 * inbox hint, a focus or reconnect, the slow poll, or the app returning to the foreground asked
 * for it. While the screen is open its newest messages count as read.
 */
export function useContentThread(
  scope: AccountScope,
  thread: ContentThreadRef,
): { readonly controller: ContentThreadController; readonly state: ContentThreadState } {
  const [controller] = useState(() => createContentThread({ scope, thread, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'content-thread', thread.threadId),
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
    controller.setActive(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (next) => {
      controller.setActive(next === 'active');
      if (next === 'active') void controller.refresh();
    });
    return () => {
      controller.setActive(false);
      subscription.remove();
    };
  }, [controller]);
  return { controller, state };
}
