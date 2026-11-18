import { useBlockReading } from '../reading/reading-viewport';
import type { BlockReadingProps, ReadingViewport } from '../reading/types';

/** Web: the browser measures a beat wherever it sits (IntersectionObserver), so its place in the essay is not needed. */
export function useBeatReading(
  viewport: ReadingViewport,
  beatId: string,
  _contentTop: number | undefined,
): BlockReadingProps {
  return useBlockReading(viewport, beatId);
}
