import { useMemo, useSyncExternalStore } from 'react';
import {
  NO_QUICK_ANSWERS,
  quickAnswerSessionFor,
  type QuickAnswerSession,
  type QuickAnswerSnapshot,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { useAccountScopeIfPresent } from '../../providers/account-scope';
import type { OpenedStageScroll } from './scroll-session';

const noSubscription = () => () => undefined;
const noSnapshot = () => NO_QUICK_ANSWERS;

/**
 * The Quick answers asked about one opened v2 Scroll (V3 D2, D-253): the account scope's session for this revision, with the
 * card at each stop. Without a signed-in scope there is no Quick answer to ask for, so the reader offers no Ask on a
 * selection. The session belongs to the scope: sign-out, an account switch, a privacy reset and Clear all end it.
 */
export function useQuickAnswers(
  scroll: OpenedStageScroll,
): { readonly snapshot: QuickAnswerSnapshot; readonly session: QuickAnswerSession } | undefined {
  const { state } = useAccountScopeIfPresent();
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  const { assetId, assetRevision } = scroll;
  const session = useMemo(
    () =>
      scope === undefined
        ? undefined
        : quickAnswerSessionFor({ scope, assetId, revision: assetRevision, newId: newCommandId }),
    [scope, assetId, assetRevision],
  );
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.getSnapshot ?? noSnapshot,
    session?.getSnapshot ?? noSnapshot,
  );
  return useMemo(() => (session === undefined ? undefined : { snapshot, session }), [session, snapshot]);
}
