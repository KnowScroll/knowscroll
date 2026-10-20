import { useMemo, useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { createScrollSession, type ScrollSession, type ScrollSessionState } from './scroll-session';

/**
 * The opening of one Scroll for the signed-in scope, as React state. The session belongs to the
 * `(scope, assetId)` pair: a different scope (sign-out, account switch, a new epoch) remounts the
 * screen (the provider is keyed by the scope), and a different asset is a different session.
 */
export function useScrollSession(
  scope: AccountScope,
  assetId: string,
): { readonly session: ScrollSession; readonly state: ScrollSessionState } {
  const session = useMemo(() => createScrollSession({ scope, assetId, newId: newCommandId }), [scope, assetId]);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}
