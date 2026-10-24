import { useState, useSyncExternalStore } from 'react';
import {
  createVisibilitySession,
  type AccountScope,
  type VisibilitySession,
  type VisibilityState,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

/** The settings page's session: it lives while the page is mounted, so a change in flight is not lost to a rerender. */
export function useVisibilitySession(scope: AccountScope): {
  readonly session: VisibilitySession;
  readonly state: VisibilityState;
} {
  const [session] = useState(() => createVisibilitySession({ scope, newId: newCommandId }));
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}
