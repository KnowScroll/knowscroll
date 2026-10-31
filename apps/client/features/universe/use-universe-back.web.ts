import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { UniverseViewSession } from './universe-session';
let sequence = 0;
/** One same-address marker; no private IDs, frame or navigation tree in browser history. */
export function useUniverseBack(
  session: Pick<UniverseViewSession, 'back' | 'canBack' | 'escape' | 'getState' | 'subscribe'>,
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
        // One step back per marker: a second notice before the browser has moved (a change that publishes
        // twice) must not take the page back past the Universe.
        else if (!session.canBack() && hasMarker() && !ignored.current) {
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
        // Escape closes what is open, and with nothing open steps up one level (D02).
        if (event.key === 'Escape' && session.escape()) {
          event.preventDefault();
          event.stopImmediatePropagation();
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
