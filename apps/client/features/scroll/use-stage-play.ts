import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { playSessionFor, type PlayCall, type PlaySnapshot } from '@knowscroll/client-core';
import { callsOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { StagePlay } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScopeIfPresent } from '../../providers/account-scope';
import type { OpenedStageScroll } from './scroll-session';

const NO_PLAY: PlaySnapshot = { locks: [], sparks: 0, combo: 0, landmark: undefined };
const noSubscription = () => () => undefined;
const noSnapshot = () => NO_PLAY;
const noPolicy = () => undefined;

/** The calls of a document, the Final call included, as the play session judges them on the device. */
function playCallsOf(document: ScrollDocumentV2): readonly PlayCall[] {
  return callsOf(document).map((call) => ({
    stopId: call.id,
    answer: call.answer,
    finalCall: call.kind === 'final_call',
  }));
}

/**
 * Play on one opened v2 Scroll (D-063, D-180): the account scope's session for this revision, read
 * once from the server when the reader opens, with the sparks and combo for the dock and the calls
 * for the reader. Without a signed-in scope there is no play layer and the reader keeps play on the
 * device alone. The session belongs to the scope: sign-out, an account switch, a privacy reset and
 * Clear all end it.
 */
export function useStagePlay(scroll: OpenedStageScroll): StagePlay | undefined {
  const { state } = useAccountScopeIfPresent();
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  const { assetId, assetRevision, document } = scroll;
  const session = useMemo(
    () =>
      scope === undefined
        ? undefined
        : playSessionFor({
            scope,
            assetId,
            revision: assetRevision,
            calls: playCallsOf(document),
            landmark: document.landmark,
            newId: newCommandId,
          }),
    [scope, assetId, assetRevision, document],
  );
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.getSnapshot ?? noSnapshot,
    session?.getSnapshot ?? noSnapshot,
  );
  const policy = useSyncExternalStore(
    scope?.recording?.subscribe ?? noSubscription,
    scope?.recording?.getState ?? noPolicy,
    scope?.recording?.getState ?? noPolicy,
  );
  const paused = policy?.policy !== undefined && !policy.policy.on;
  useEffect(() => {
    void session?.load();
  }, [session]);
  return useMemo(
    () => (session === undefined ? undefined : { ...snapshot, paused, lock: session.lock }),
    [session, snapshot, paused],
  );
}
