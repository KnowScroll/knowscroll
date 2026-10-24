import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  TALK_QUERY_KEY,
  inboxRowView,
  readInboxPage,
  type AccountScope,
  type InboxPage,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

/** How often an open Talk list asks again, in case a live hint was lost. */
const POLL_MS = 30_000;

class StaleInboxCursor extends Error {}

/**
 * The Talk inbox as TanStack pages under the scope's Talk key, so a live inbox hint refreshes it
 * (`connectScopeSocket`), and focus and reconnect do too. Without a scope (signed out) it is idle.
 * A cursor the server calls stale starts the list over from the first page.
 */
export function useTalkInbox(scope: AccountScope | undefined) {
  const client = useQueryClient();
  const key = scope === undefined ? ([TALK_QUERY_KEY, 'signed-out'] as const) : scope.queryKey(TALK_QUERY_KEY, 'inbox');
  const query = useInfiniteQuery<
    InboxPage,
    Error,
    { pages: InboxPage[] },
    readonly (string | number)[],
    string | undefined
  >({
    queryKey: key,
    enabled: scope !== undefined,
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      if (scope === undefined) throw new Error('no scope');
      const page = await readInboxPage(scope, newCommandId, pageParam);
      if (page === 'restart') throw new StaleInboxCursor();
      return page;
    },
    getNextPageParam: (last) => last.next,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const stale = query.error instanceof StaleInboxCursor;
  useEffect(() => {
    if (stale) void client.resetQueries({ queryKey: key });
  }, [stale, client, key]);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    items,
    /** Nothing has been read yet. */
    loading: query.isPending && scope !== undefined,
    /** The latest read failed; `items` may still show what was read before. */
    failed: query.isError && !stale,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
    /** Something the person has not read is waiting (never a count). */
    unread: items.some((item) => inboxRowView(item).unread),
  };
}
