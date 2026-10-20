import { useCallback, useEffect, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { ScrollReadingObserver } from '../observer';
import type { BlockReadingProps, ReadingInsets, ReadingViewport } from './types';
import { createVisibilityTracker, monotonicNow, visibleFractionOf, type VisibilityTracker } from './visibility';

interface BlockBox {
  top: number;
  height: number;
}

class NativeReadingViewport implements ReadingViewport {
  readonly scrollProps: ReadingViewport['scrollProps'];
  private readonly boxes = new Map<string, BlockBox>();
  private readonly tracker: VisibilityTracker;
  private scrollTop = 0;
  private height = 0;

  private observer: ScrollReadingObserver | undefined;
  private insets: ReadingInsets = { top: 0, bottom: 0 };

  constructor() {
    this.tracker = createVisibilityTracker(() => this.observer, monotonicNow);
    this.scrollProps = {
      scrollEventThrottle: 16,
      onLayout: (event: LayoutChangeEvent) => {
        this.height = event.nativeEvent.layout.height;
        this.measureAll();
      },
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        this.scrollTop = event.nativeEvent.contentOffset.y;
        // A scroll event that carries the viewport height keeps it fresh (rotation, keyboard).
        const measured = event.nativeEvent.layoutMeasurement.height;
        if (measured > 0) this.height = measured;
        this.measureAll();
      },
    };
  }

  /** The latest observer and insets (set after every render, read when events arrive). */
  configure(observer: ScrollReadingObserver | undefined, insets: ReadingInsets): void {
    const replaced = this.observer !== observer;
    this.observer = observer;
    this.insets = insets;
    if (replaced) this.tracker.replay();
  }

  private fractionOf(box: BlockBox): number {
    const { top, bottom } = this.insets;
    return visibleFractionOf(box.top, box.height, this.scrollTop + top, this.height - top - bottom);
  }

  private measureAll(): void {
    for (const [blockId, box] of this.boxes) this.tracker.measured(blockId, this.fractionOf(box));
  }

  blockMounted(blockId: string): void {
    this.tracker.mounted(blockId, 0);
  }

  blockUnmounted(blockId: string): void {
    this.boxes.delete(blockId);
    this.tracker.unmounted(blockId);
  }

  blockLaidOut(blockId: string, top: number, height: number): void {
    const box = { top, height };
    this.boxes.set(blockId, box);
    this.tracker.measured(blockId, this.fractionOf(box));
  }
}

/** One reading viewport per article; it reports to the latest `observer` and `insets`. */
export function useReadingViewport(
  observer: ScrollReadingObserver | undefined,
  insets: ReadingInsets,
): ReadingViewport {
  const [viewport] = useState(() => {
    // Configured at creation, so blocks that mount before this component's effect runs (children's
    // effects run first) already report to the observer; later changes arrive through the effect.
    const created = new NativeReadingViewport();
    created.configure(observer, insets);
    return created;
  });
  useEffect(() => {
    viewport.configure(observer, insets);
  });
  return viewport;
}

/** Props for a block's wrapper view: native reports its layout. */
export function useBlockReading(viewport: ReadingViewport, blockId: string): BlockReadingProps {
  useEffect(() => {
    viewport.blockMounted(blockId);
    return () => viewport.blockUnmounted(blockId);
  }, [viewport, blockId]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      viewport.blockLaidOut(blockId, y, height);
    },
    [viewport, blockId],
  );
  return { onLayout };
}
