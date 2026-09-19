import { useEffect } from 'react';

/**
 * Fires `onVisible(assetId)` the first time the stage is at least substantially
 * in the viewport (default 60% intersection ratio) while the document itself
 * is visible. Never fires for a hidden tab or an off-screen/prefetched stage;
 * re-checks on `visibilitychange` in case intersection happened while hidden.
 */
export function useVisibleExposure(
  node: HTMLElement | null,
  assetId: string | null,
  onVisible: (assetId: string) => void,
  threshold = 0.6,
): void {
  useEffect(() => {
    if (!node || !assetId) return undefined;
    let fired = false;
    let ratio = 0;
    const attempt = () => {
      if (fired) return;
      if (document.visibilityState === 'visible' && ratio >= threshold) {
        fired = true;
        onVisible(assetId);
      }
    };
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) ratio = entry.intersectionRatio;
        attempt();
      },
      { threshold: [0, threshold, 1] },
    );
    observer.observe(node);
    document.addEventListener('visibilitychange', attempt);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', attempt);
    };
  }, [node, assetId, onVisible, threshold]);
}
