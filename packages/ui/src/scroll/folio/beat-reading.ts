import { useCallback, useEffect, useRef } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { BlockReadingProps, ReadingViewport } from '../reading/types';

/**
 * Native: reports a beat's box to the reading viewport in the essay's coordinates. A layout event gives a position
 * inside the beat's parent, so a beat inside a hold adds where its slot starts (`contentTop`), says nothing until that is
 * known, and reports again when it moves.
 */
export function useBeatReading(
  viewport: ReadingViewport,
  beatId: string,
  contentTop: number | undefined,
): BlockReadingProps {
  const box = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    viewport.blockMounted(beatId);
    return () => viewport.blockUnmounted(beatId);
  }, [viewport, beatId]);
  useEffect(() => {
    if (box.current !== null && contentTop !== undefined)
      viewport.blockLaidOut(beatId, contentTop + box.current.y, box.current.height);
  }, [viewport, beatId, contentTop]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      box.current = { y, height };
      if (contentTop !== undefined) viewport.blockLaidOut(beatId, contentTop + y, height);
    },
    [viewport, beatId, contentTop],
  );
  return { onLayout };
}
