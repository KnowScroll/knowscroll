import { useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { createEncounterSession, type EncounterSession } from './encounter-session';

const sessions = new WeakMap<AccountScope, EncounterSession>();
/** Scope ownership, rather than a mount effect, prevents StrictMode disposing retained resources. */
export function encounterSessionFor(scope: AccountScope) {
  let session = sessions.get(scope);
  if (!session) {
    session = createEncounterSession(scope, newCommandId);
    sessions.set(scope, session);
  }
  return session;
}
export function useEncounterSession(scope: AccountScope) {
  const session = encounterSessionFor(scope);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}
