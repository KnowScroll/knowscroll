import { useEffect, useState } from 'react';
import { talkFailure, type AccountScope } from '@knowscroll/client-core';
import { SavedPageResponseSchema, type SavedPageResponse } from '@knowscroll/contracts';

export type KeptItem = SavedPageResponse['items'][number];

export type KeptState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly items: readonly KeptItem[] };

/**
 * The kept Reels and Scrolls a person can bring into a room: the current, admitted revisions only. It is the person's own Keep list,
 * read when they open a sheet that offers it; nothing is sent about what they chose until they send it.
 */
export function useKept(scope: AccountScope, enabled: boolean): KeptState {
  const [state, setState] = useState<KeptState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    scope.api.experience
      .listSaved({ pagination: 'saved-page.v1', filter: 'all', limit: '20' })
      .then((page) => {
        if (!current) return;
        const parsed = SavedPageResponseSchema.parse(page);
        setState({ status: 'ready', items: parsed.items.filter((item) => item.availability === 'available') });
      })
      .catch((error: unknown) => {
        if (current && talkFailure(error) !== 'ended') setState({ status: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [scope, enabled]);
  return state;
}
