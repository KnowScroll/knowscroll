import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { TALK_QUERY_KEY, readThreadSummaries, type AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

/** How often Talk asks again for threads, in case a live hint was lost. */
const POLL_MS = 30_000;

/**
 * The person's threads (joined and invited) under the scope's Talk key, so a live inbox hint, a
 * focus and a reconnect refresh it with the rest of Talk. Without a scope it is idle.
 */
export function useThreadInbox(scope: AccountScope | undefined) {
  const key = useMemo(
    () => (scope === undefined ? ([TALK_QUERY_KEY, 'signed-out', 'threads'] as const) : scope.queryKey(TALK_QUERY_KEY, 'threads')),
    [scope],
  );
  const query = useQuery({
    queryKey: key,
    enabled: scope !== undefined,
    queryFn: () => {
      if (scope === undefined) throw new Error('no scope');
      return readThreadSummaries(scope, newCommandId);
    },
    refetchInterval: POLL_MS,
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
