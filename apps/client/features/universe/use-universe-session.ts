import { useEffect, useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { createUniverseViewSession, type UniverseViewSession } from './universe-session';
const sessions = new WeakMap<AccountScope, UniverseViewSession>();
export function universeSessionFor(scope: AccountScope) {
  let session = sessions.get(scope);
  if (!session) {
    session = createUniverseViewSession(scope);
    sessions.set(scope, session);
  }
  return session;
}
export function useUniverseSession(scope: AccountScope, reducedMotion: boolean) {
  const session = universeSessionFor(scope),
    state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => session.configure({ detail: state.detail, reducedMotion }), [session, state.detail, reducedMotion]);
  return { session, state };
}
