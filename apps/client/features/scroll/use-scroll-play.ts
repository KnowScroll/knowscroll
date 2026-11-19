import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { playSessionFor, type PlayCall, type PlaySnapshot } from '@knowscroll/client-core';
import { callsOf, SCROLL_DOCUMENT_V2_SCHEMA_VERSION, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { CallPlay } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScopeIfPresent } from '../../providers/account-scope';
import { useRecordingPausedIn } from '../../providers/use-recording-paused';
import type { OpenedScrollFolio } from './scroll-session';

const NO_PLAY: PlaySnapshot = { locks: [], sparks: 0, combo: 0, landmark: undefined };
const noSubscription = () => () => undefined;
const noSnapshot = () => NO_PLAY;

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
 * once from the server when Ask's waiting puzzle opens, with the calls it locks and the sparks and
 * combo they earn. Without a signed-in scope there is no play layer and the puzzle keeps play on the
 * device alone. The session belongs to the scope: sign-out, an account switch, a privacy reset and
 * Clear all end it. A v3 Scroll has no calls to play (decision I1), so it has no play layer at all.
 */
export function useScrollPlay(scroll: OpenedScrollFolio): CallPlay | undefined {
  const { state } = useAccountScopeIfPresent();
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  const { assetId, assetRevision, document } = scroll;
  const session = useMemo(
    () =>
      scope === undefined || document.schemaVersion !== SCROLL_DOCUMENT_V2_SCHEMA_VERSION
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
  const paused = useRecordingPausedIn(scope);
  useEffect(() => {
    void session?.load();
  }, [session]);
  return useMemo(
    () => (session === undefined ? undefined : { ...snapshot, paused, lock: session.lock }),
    [session, snapshot, paused],
  );
}
