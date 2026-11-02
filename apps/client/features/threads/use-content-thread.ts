import { useQuery } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import {
  TALK_QUERY_KEY,
  createContentThread,
  type AccountScope,
  type ContentThreadController,
  type ContentThreadState,
} from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';
import { useReadingWhileInView } from '../../platform/use-reading-while-in-view';

/** How often an open thread asks again, in case a live hint was lost. */
const POLL_MS = 20_000;

/**
 * One open thread. The controller holds it; this hook starts it and keeps it fresh: the first run
 * reads the thread, every later run catches up from the last confirmed position, whether a live
 * inbox hint, a focus or reconnect, the slow poll, or the app returning to the foreground asked
 * for it. While the screen is in view its newest messages count as read, and only then.
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
  useReadingWhileInView(controller);
  return { controller, state };
}
