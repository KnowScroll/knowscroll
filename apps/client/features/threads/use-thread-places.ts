import { useQuery } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import {
  TALK_QUERY_KEY,
  createThreadPlaces,
  type AccountScope,
  type ThreadPlacesController,
  type ThreadPlacesState,
} from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/** How often an open thread asks for the places again, in case a live hint was lost. */
const POLL_MS = 20_000;

/**
 * One open thread's places (D-065). The first read, every live hint (they refetch Talk's queries), a focus,
 * a reconnect and a slow poll read them again, so a lost hint only delays an update. The thread's player
 * reports this person's own place through the controller; nothing else does.
 */
export function useThreadPlaces(
  scope: AccountScope,
  thread: ContentThreadRef,
): { readonly controller: ThreadPlacesController; readonly state: ThreadPlacesState } {
  const [controller] = useState(() => createThreadPlaces({ scope, thread, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'thread-places', thread.threadId),
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
