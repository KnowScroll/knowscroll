import * as Clipboard from 'expo-clipboard';
import { useState, useSyncExternalStore } from 'react';
import {
  createShareSession,
  createSharedLinksSession,
  type AccountScope,
  type ShareSession,
  type ShareState,
  type SharedLinksSession,
  type SharedLinksState,
} from '@knowscroll/client-core';
import type { ConversationContentRef } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/** One share sheet's session: it lives while the sheet is mounted, so a draft note survives switching options. */
export function useShareSession(
  scope: AccountScope,
  target: ConversationContentRef,
  origin: string,
  challenge?: { readonly stopId: string },
): { readonly session: ShareSession; readonly state: ShareState } {
  const [session] = useState(() =>
    createShareSession({
      scope,
      target,
      challenge,
      origin,
      newId: newCommandId,
      copyText: async (text) => {
        await Clipboard.setStringAsync(text);
      },
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}

export function useSharedLinks(scope: AccountScope): {
  readonly session: SharedLinksSession;
  readonly state: SharedLinksState;
} {
  const [session] = useState(() => createSharedLinksSession({ scope, newId: newCommandId }));
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}
