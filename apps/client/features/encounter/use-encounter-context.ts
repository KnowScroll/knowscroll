import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccountScope } from '@knowscroll/client-core';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession } from './encounter-session';

/** Observe current server state so scoped catch-up invalidation refetches it. Back uses its cached read. */
export function useEncounterContext(
  scope: AccountScope,
  session: EncounterSession,
  entry: EncounterEntry | undefined,
  foreground: boolean,
) {
  const exposureId = entry?.exposureId;
  const query = useQuery({
    queryKey: scope.queryKey('encounter', 'context', exposureId ?? 'none'),
    queryFn: () => scope.api.experience.exposureContext({ exposureId: exposureId! }),
    enabled: foreground && exposureId !== undefined,
    initialData: entry?.context,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (exposureId && query.data) session.acceptContext(exposureId, query.data);
  }, [session, exposureId, query.data]);
  useEffect(() => {
    if (exposureId && query.error) session.contextFailure(exposureId, query.error);
  }, [session, exposureId, query.error]);
}
