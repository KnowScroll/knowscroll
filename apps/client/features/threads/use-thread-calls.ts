import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  TALK_QUERY_KEY,
  callKey,
  createThreadCalls,
  type AccountScope,
  type ThreadCallsController,
  type ThreadCallsState,
} from '@knowscroll/client-core';
import type { ContentThreadRef, ThreadCall } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/** How often an open thread asks for its calls again, in case a live hint was lost. */
const POLL_MS = 20_000;

const seenKey = (threadId: string) => `thread.calls.seen.${threadId}`;

/** The reveals this person opened on this device. Never sent: only a part and an exact revision, never a pick. */
function readSeen(scope: AccountScope, threadId: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(scope.storage.get(seenKey(threadId)) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * One open thread's calls (D-155). The first read, every live hint (they refetch Talk's queries), a focus, a reconnect
 * and a slow poll read them again, so a lost hint only delays an update. Only a series thread has calls: for any other
 * the controller is idle and reads nothing. What was opened is this device's own memory, in the account scope's storage.
 */
export function useThreadCalls(
  scope: AccountScope,
  thread: ContentThreadRef,
  series: boolean,
): {
  readonly controller: ThreadCallsController;
  readonly state: ThreadCallsState;
  readonly seen: ReadonlySet<string>;
  readonly markSeen: (call: ThreadCall) => void;
} {
  const [controller] = useState(() => createThreadCalls({ scope, thread, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [seen, setSeen] = useState(() => readSeen(scope, thread.threadId));
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'thread-calls', thread.threadId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    enabled: series,
    staleTime: 0,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const markSeen = useCallback(
    (call: ThreadCall) => {
      setSeen((before) => {
        const key = callKey(call);
        if (before.has(key)) return before;
        const next = new Set(before).add(key);
        scope.storage.set(seenKey(thread.threadId), JSON.stringify([...next]));
        return next;
      });
    },
    [scope, thread.threadId],
  );
  return { controller, state, seen, markSeen };
}
