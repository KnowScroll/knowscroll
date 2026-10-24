import { useEffect } from 'react';

/** How many open overlays currently hold the page inert; the last one to close lets go. */
let holders = 0;

function appRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('root');
}

/**
 * While a modal overlay is open, the page behind it is `inert`: not focusable, not clickable and
 * hidden from screen readers and from contrast checks, as a modal dialog promises. The overlay
 * itself is drawn into `document.body`, outside the app root, so it stays live. Holds are counted,
 * so a sheet opened over a sheet does not free the page when the top one closes.
 */
export function usePageInert(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    holders += 1;
    appRoot()?.setAttribute('inert', '');
    return () => {
      holders -= 1;
      if (holders === 0) appRoot()?.removeAttribute('inert');
    };
  }, [active]);
}
