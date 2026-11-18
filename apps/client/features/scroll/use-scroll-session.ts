import { useMemo, useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { createScrollSession, type ScrollSession, type ScrollSessionState } from './scroll-session';
import { ARTICLE_ONLY, type ScrollReaderKind } from './scroll-readers';

/**
 * The opening of one Scroll for the signed-in scope, as React state. The session belongs to the
 * `(scope, assetId)` pair: a different scope (sign-out, account switch, a new epoch) remounts the
 * screen (the provider is keyed by the scope), and a different asset is a different session.
 */
export function useScrollSession(
  scope: AccountScope,
  assetId: string,
  /** The readers the screen draws with; pass a constant list, so the session is not rebuilt on every render. */
  readers: readonly ScrollReaderKind[] = ARTICLE_ONLY,
): { readonly session: ScrollSession; readonly state: ScrollSessionState } {
  const session = useMemo(
    () => createScrollSession({ scope, assetId, newId: newCommandId, readers }),
    [scope, assetId, readers],
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}
