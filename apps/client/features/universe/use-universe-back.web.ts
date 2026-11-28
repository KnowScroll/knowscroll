import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { UniverseViewSession } from './universe-session';
let sequence = 0;

/**
 * The browser's own keys of the history entries a marker was pushed on. The router rewrites an entry's state when it
 * comes back to it (Leave on a friend's Universe returns onto the entry the outer stop pushed), and the marker goes with
 * it: the entry is then the same address as the one under it, and Back over it would look dead. The key survives, where
 * the browser has the Navigation API; elsewhere only the state is read, as before.
 */
const markerEntries = new Set<string>();
const entryKey = (): string | undefined =>
  (globalThis as { navigation?: { currentEntry?: { key?: string } | null } }).navigation?.currentEntry?.key;

/**
 * One same-address marker; no private IDs, frame or navigation tree in browser history. `knowsEntries` also finds the
 * marker's entry by the browser's key ({@link markerEntries}); only the trial look asks for it, so the Universe with the
 * trial switch off keeps its history as it was.
 */
export function useUniverseBack(
  session: Pick<UniverseViewSession, 'back' | 'canBack' | 'escape' | 'getState' | 'subscribe'> &
    Partial<Pick<UniverseViewSession, 'showOverlay'>>,
  enabled: boolean,
  knowsEntries = false,
) {
  const marker = useRef(`universe-${String(++sequence)}`),
    ignored = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const hasMarker = () => (window.history.state as { ksUniverse?: unknown } | null)?.ksUniverse === marker.current;
      /** On an entry a marker was pushed on, whatever its state says now. */
      const onMarkerEntry = () => {
        const key = knowsEntries ? entryKey() : undefined;
        return key !== undefined && markerEntries.has(key);
      };
      const sync = () => {
        if (session.canBack() && !hasMarker()) {
          const entry = { ...(window.history.state as object | null), ksUniverse: marker.current };
          // An entry a marker was pushed on is taken back as it is, not stacked on.
          if (onMarkerEntry()) window.history.replaceState(entry, '', window.location.href);
          else {
            window.history.pushState(entry, '', window.location.href);
            const key = knowsEntries ? entryKey() : undefined;
            if (key !== undefined) markerEntries.add(key);
          }
        }
        // One step back per marker: a second notice before the browser has moved (a change that publishes
        // twice) must not take the page back past the Universe.
        else if (!session.canBack() && (hasMarker() || onMarkerEntry()) && !ignored.current) {
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
        // A sheet over the map took its own entry off: ours is still there, so nothing moved up a level.
        if (hasMarker()) return;
        session.back();
        sync();
      };
      const key = (event: KeyboardEvent) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (
          event.key === '/' &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !target?.closest('input, textarea, [contenteditable="true"]') &&
          session.showOverlay &&
          session.getState().overlay !== 'settings'
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          session.showOverlay('search');
          return;
        }
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
    }, [session, enabled, knowsEntries]),
  );
  return session.back;
}
