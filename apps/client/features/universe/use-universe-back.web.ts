import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { UniverseViewSession } from './universe-session';
let sequence = 0;
/** One same-address marker; no private IDs, frame or navigation tree in browser history. */
export function useUniverseBack(
  session: Pick<UniverseViewSession, 'back' | 'canBack' | 'getState' | 'subscribe'>,
  enabled: boolean,
) {
  const marker = useRef(`universe-${String(++sequence)}`),
    ignored = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const hasMarker = () => (window.history.state as { ksUniverse?: unknown } | null)?.ksUniverse === marker.current;
      const sync = () => {
        if (session.canBack() && !hasMarker())
          window.history.pushState({ ...window.history.state, ksUniverse: marker.current }, '', window.location.href);
        else if (!session.canBack() && hasMarker()) {
          ignored.current = true;
          window.history.back();
        }
      };
      const unsubscribe = session.subscribe(sync);
      const pop = () => {
        if (ignored.current) {
          ignored.current = false;
          return;
        }
        session.back();
        sync();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && session.getState().overlay) {
          event.preventDefault();
          event.stopImmediatePropagation();
          session.back();
        }
      };
      sync();
      window.addEventListener('popstate', pop);
      window.addEventListener('keydown', key);
      return () => {
        unsubscribe();
        window.removeEventListener('popstate', pop);
        window.removeEventListener('keydown', key);
      };
    }, [session, enabled]),
  );
  return session.back;
}
