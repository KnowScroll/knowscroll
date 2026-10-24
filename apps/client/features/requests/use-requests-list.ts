import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { createRequestsListSession, type RequestsListSession } from './requests-list-session';

type Mounted = { scope: AccountScope; session: RequestsListSession } | undefined;
/** React observes this external slot; only effect setup and cleanup acquire and release the session. */
function mountedSession() {
  let current: Mounted;
  const listeners = new Set<() => void>();
  const publish = (next: Mounted) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: (scope: AccountScope) => {
      if (!scope.active) return undefined;
      const session = createRequestsListSession(scope, newCommandId);
      publish({ scope, session });
      session.visible(true);
      return () => {
        session.visible(false);
        if (current?.session === session) publish(undefined);
      };
    },
  };
}

/**
 * The requests list of the signed-in person for as long as the calling view is mounted: it reads on
 * mount and looks again quietly while something is preparing. Keyed by the scope object, so an
 * account or epoch change drops it. Mount `RequestsList` with the result.
 */
export function useRequestsList(scope: AccountScope): RequestsListSession | undefined {
  const [owner] = useState(mountedSession);
  const current = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useEffect(() => owner.mount(scope), [owner, scope]);
  return current?.scope === scope && scope.active ? current.session : undefined;
}
