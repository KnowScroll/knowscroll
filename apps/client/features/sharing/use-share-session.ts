import { useCallback, useSyncExternalStore } from 'react';
import { createContentSharesSession, type AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

type Session = ReturnType<typeof createContentSharesSession>;
const owners = new WeakMap<AccountScope, Session>();
/** Secret delivery is held once by core, never React state, storage, a query key or a URL. */
export function sharesFor(scope: AccountScope): Session {
  let session = owners.get(scope);
  if (!session) {
    session = createContentSharesSession({ scope, newCommandId });
    owners.set(scope, session);
    const retained = session;
    scope.onEnd?.(() => {
      retained.dispose();
      // Preserve only the ended body-free owner for a final old-subtree render.
    });
  }
  return session;
}
export function useShareSession(scope: AccountScope) {
  const session = sharesFor(scope);
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const snapshot = useCallback(() => session.getState(), [session]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { session, state };
}
