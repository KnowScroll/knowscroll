import { useEffect, useRef } from 'react';

const marker = '__ksOverlay';

function overlayToken(state: unknown): unknown {
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[marker] : undefined;
}

/** The entry of an overlay that has just closed and not yet been removed from history. */
let leavingEntry: { readonly token: string } | undefined;

/**
 * Web: browser Back while an overlay is open closes the overlay and nothing else (N01, ruling on
 * #255). Opening adds one transient entry for the same address (a copy of the router's state,
 * marked); Back pops it and closes the overlay; closing any other way (Esc, Close, the scrim)
 * removes the entry again, so the person's own history is unchanged. An overlay that opens in the
 * same commit that closes another (a menu sheet that opens a report sheet) takes over the closing
 * overlay's entry; removing it with Back would also pop the new overlay's entry and close it at once.
 */
export function useOverlayHistory(visible: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!visible || typeof window === 'undefined') return undefined;
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const base = (window.history.state ?? {}) as Record<string, unknown>;
    if (leavingEntry !== undefined && overlayToken(base) === leavingEntry.token) {
      leavingEntry = undefined;
      window.history.replaceState({ ...base, [marker]: token }, '', window.location.href);
    } else {
      window.history.pushState({ ...base, [marker]: token }, '', window.location.href);
    }
    let poppedByBrowser = false;
    const onPopState = () => {
      if (overlayToken(window.history.state) === token) return;
      poppedByBrowser = true;
      close.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (poppedByBrowser || overlayToken(window.history.state) !== token) return;
      const entry = { token };
      leavingEntry = entry;
      // Every effect of this commit has run by the next microtask: remove the entry unless one took it over.
      queueMicrotask(() => {
        if (leavingEntry !== entry) return;
        leavingEntry = undefined;
        if (overlayToken(window.history.state) === token) window.history.back();
      });
    };
  }, [visible]);
}
