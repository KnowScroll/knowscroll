import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { claimOverlayEntry } from '@knowscroll/ui';
import { notePendingBack } from '../../platform/after-pending-back';
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
        if (needsBack && !hasMarker()) {
          // A sheet that closes as this one opens (••• then Share) hands over its entry rather than leave one to pop.
          const claimed = claimOverlayEntry(window.history.state);
          const next = { ...claimed.state, ksEncounter: marker.current };
          if (claimed.replace) window.history.replaceState(next, '', window.location.href);
          else window.history.pushState(next, '', window.location.href);
        }
        // One pop is enough: several publishes can land before the popstate that removes the marker.
        else if (!needsBack && hasMarker() && !ignored.current) {
          ignored.current = true;
          notePendingBack();
          window.history.back();
        }
      };
      const unsubscribe = session.subscribe(sync);
      const pop = () => {
        if (ignored.current) {
          ignored.current = false;
          // State may have changed while the marker was being removed (an overlay opened again).
          sync();
          return;
        }
        // A sheet of the reader's own (••• over a Scroll) took its entry off: ours is still there, so nothing moved.
        if (hasMarker()) return;
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
