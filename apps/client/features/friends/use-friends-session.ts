import { useEffect, useState, useSyncExternalStore } from 'react';
import { createFriendsSession, type AccountScope, type FriendsSession } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

type Mounted = { scope: AccountScope; session: FriendsSession } | undefined;
/** React observes this external resource slot; only effect setup/cleanup acquires/disposes it. */
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
      const session = createFriendsSession({ scope, newCommandId });
      publish({ scope, session });
      return () => {
        session.dispose();
        if (current?.session === session) publish(undefined);
      };
    },
  };
}
/** A mounted view owns one ephemeral session, keyed by scope OBJECT rather than account text. */
export function useFriendsSession(scope: AccountScope): FriendsSession | undefined {
  const [owner] = useState(mountedSession);
  const current = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useEffect(() => owner.mount(scope), [owner, scope]);
  return current?.scope === scope && scope.active ? current.session : undefined;
}
