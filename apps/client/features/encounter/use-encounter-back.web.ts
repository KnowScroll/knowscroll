import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { EncounterSession } from './encounter-session';

let markerSequence = 0;
/** One transient same-address sentinel, never a persisted navigation tree. The controller owns the path. */
export function useEncounterBack(session: EncounterSession, enabled: boolean) {
  const marker = useRef(`encounter-${String(++markerSequence)}`);
  const ignored = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const hasMarker = () =>
        (window.history.state as { ksEncounter?: unknown } | null)?.ksEncounter === marker.current;
      const sync = () => {
        const state = session.getState();
        const needsBack = state.overlay || session.canBack();
        if (needsBack && !hasMarker())
          window.history.pushState({ ...window.history.state, ksEncounter: marker.current }, '', window.location.href);
        else if (!needsBack && hasMarker()) {
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
        // Back closes an overlay first or restores one retained entry, synchronously, without API work.
        session.back();
        sync();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && session.getState().overlay) {
          event.preventDefault();
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
  return () => session.back();
}
