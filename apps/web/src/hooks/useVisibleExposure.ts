import { useEffect } from 'react';

/**
 * Fires `onVisible(assetId)` the first time the stage substantially occupies
 * the viewport (default 60% of the smaller of stage and viewport) while the
 * document itself is visible. A long article can be much taller than a phone;
 * comparing against its full height would leave a visibly read Scroll forever
 * unexposed. Never fires for a hidden tab or an off-screen/prefetched stage;
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
        for (const entry of entries) {
          const visibleHeight = Math.min(entry.boundingClientRect.height, document.documentElement.clientHeight);
          const visibleWidth = Math.min(entry.boundingClientRect.width, document.documentElement.clientWidth);
          ratio = visibleHeight > 0 && visibleWidth > 0
            ? (entry.intersectionRect.height * entry.intersectionRect.width) / (visibleHeight * visibleWidth)
            : 0;
        }
        attempt();
      },
      // Long articles may never reach a .6 *element* ratio, so request
      // intermediate crossings and evaluate viewport occupancy ourselves.
      { threshold: Array.from({ length: 51 }, (_, index) => index / 50) },
    );
    observer.observe(node);
    document.addEventListener('visibilitychange', attempt);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', attempt);
    };
  }, [node, assetId, onVisible, threshold]);
}
