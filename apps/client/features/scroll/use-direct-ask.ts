import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { createRequestSession } from '../requests/request-session';
import type { OpenedStageScroll } from './scroll-session';

/**
 * Ask from here on a Scroll's own address (`/scroll/<id>`), where there is no encounter. It is the same Ask as Explore's
 * (D-218, D-231, D-262): the same request session, sheet, caps and rules. The source of the question is the Scroll's own
 * exposure (a direct encounter has no experience session), which the server checks like any other. The session lives as
 * long as this reader, so a question that is still being made is announced here when it is ready.
 *
 * `currentStop` names the stop on screen when Ask opens; the last stop stands in at the end of the Scroll.
 */
export function useDirectAsk(scope: AccountScope, scroll: OpenedStageScroll, currentStop: () => string | undefined) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { exposureId, assetId, assetRevision } = scroll;
  const source = useMemo(() => ({ exposureId, assetId, assetRevision }), [exposureId, assetId, assetRevision]);
  const session = useMemo(
    () =>
      createRequestSession(
        scope,
        newCommandId,
        () => source,
        (target) => {
          setOpen(false);
          router.push(`/scroll/${target.assetId}`);
          return true;
        },
      ),
    [scope, source, router],
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  // While a question is outstanding the session keeps reading it, so the ready notice is true even with the sheet shut.
  const watching =
    state.phase === 'accepted' && state.receipt !== undefined && state.dismissedRequestId !== state.receipt.requestId;
  useEffect(() => {
    session.visible(open || watching);
  }, [session, open, watching]);
  // Leaving the screen (or a new session replacing this one) stops every read made for it.
  useEffect(() => () => session.visible(false), [session]);
  const ask = useCallback(
    (stopId: string | undefined) => {
      const anchor = stopId ?? scroll.document.stops.at(-1)?.id;
      if (anchor === undefined || !session.show('ask', { stopId: anchor })) return false;
      setOpen(true);
      return true;
    },
    [session, scroll.document.stops],
  );
  return {
    session,
    open,
    close: useCallback(() => setOpen(false), []),
    /** Opens the answer from the ready notice, and puts the notice away once it has opened (as Explore's does). */
    openReady: useCallback(async () => {
      if (await session.openReady()) session.dismissNotice();
    }, [session]),
    /** Ask from the stop on screen. */
    openAsk: useCallback(() => ask(currentStop()), [ask, currentStop]),
    /**
     * "Make it a full Scroll" under a Quick answer: Ask from here at the stop, with the answer's question (or the selected
     * words) as the first draft the person may change (D-244, D-253).
     */
    openAbout: useCallback(
      (stopId: string, passage: string, question?: string) => {
        if (ask(stopId))
          session.edit({ about: true, text: (question ?? `Tell me more about “${passage}”`).slice(0, 280) });
      },
      [ask, session],
    ),
  };
}
