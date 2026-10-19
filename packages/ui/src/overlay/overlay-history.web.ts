import { useEffect, useRef } from 'react';

const marker = '__ksOverlay';

function overlayToken(state: unknown): unknown {
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[marker] : undefined;
}

/**
 * Web: browser Back while an overlay is open closes the overlay and nothing else (N01, ruling on
 * #255). Opening adds one transient entry for the same address (a copy of the router's state,
 * marked); Back pops it and closes the overlay; closing any other way (Esc, Close, the scrim)
 * removes the entry again, so the person's own history is unchanged.
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
    window.history.pushState({ ...base, [marker]: token }, '', window.location.href);
    let poppedByBrowser = false;
    const onPopState = () => {
      if (overlayToken(window.history.state) === token) return;
      poppedByBrowser = true;
      close.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!poppedByBrowser && overlayToken(window.history.state) === token) window.history.back();
    };
  }, [visible]);
}
