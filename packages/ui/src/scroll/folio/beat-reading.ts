import { useCallback, useEffect, useRef } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { BlockReadingProps, ReadingViewport } from '../reading/types';

/**
 * Native: reports a beat's box to the reading viewport in the essay's coordinates. A layout event gives a position
 * inside the beat's parent, so a beat inside a hold adds where its column starts (`contentTop`), and reports again when
 * that moves.
 */
export function useBeatReading(viewport: ReadingViewport, beatId: string, contentTop: number): BlockReadingProps {
  const box = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    viewport.blockMounted(beatId);
    return () => viewport.blockUnmounted(beatId);
  }, [viewport, beatId]);
  useEffect(() => {
    if (box.current !== null) viewport.blockLaidOut(beatId, contentTop + box.current.y, box.current.height);
  }, [viewport, beatId, contentTop]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      box.current = { y, height };
      viewport.blockLaidOut(beatId, contentTop + y, height);
    },
    [viewport, beatId, contentTop],
  );
  return { onLayout };
}
