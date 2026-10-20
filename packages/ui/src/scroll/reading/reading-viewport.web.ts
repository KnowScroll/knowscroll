import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewInstance } from 'react-native';
import type { ScrollReadingObserver } from '../observer';
import type { BlockReadingProps, ReadingInsets, ReadingViewport } from './types';
import { createVisibilityTracker, monotonicNow, type VisibilityTracker } from './visibility';

/** Every tenth of the block: the tracker decides which changes are events. */
const THRESHOLDS = Array.from({ length: 11 }, (_, index) => index / 10);

/** Web: IntersectionObserver gives the visible fraction of each block inside the viewport. */
class WebReadingViewport implements ReadingViewport {
  readonly scrollProps = {};
  private readonly tracker: VisibilityTracker;
  private readonly ids = new Map<Element, string>();
  private io: IntersectionObserver | null = null;

  private observerOf: ScrollReadingObserver | undefined;
  private insets: ReadingInsets = { top: 0, bottom: 0 };

  constructor() {
    this.tracker = createVisibilityTracker(() => this.observerOf, monotonicNow);
  }

  /** The latest observer and insets (set after every render, read when events arrive). */
  configure(observer: ScrollReadingObserver | undefined, insets: ReadingInsets): void {
    this.observerOf = observer;
    this.insets = insets;
  }

  private observer(): IntersectionObserver | null {
    if (this.io !== null) return this.io;
    if (typeof IntersectionObserver === 'undefined') return null;
    const { top, bottom } = this.insets;
    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const blockId = this.ids.get(entry.target);
          if (blockId !== undefined) this.tracker.measured(blockId, entry.intersectionRatio);
        }
      },
      { threshold: THRESHOLDS, rootMargin: `${-top}px 0px ${-bottom}px 0px` },
    );
    return this.io;
  }

  blockMounted(blockId: string): void {
    this.tracker.mounted(blockId, 0);
  }

  blockUnmounted(blockId: string): void {
    this.tracker.unmounted(blockId);
  }

  blockLaidOut(): void {}

  attach(blockId: string, element: Element): () => void {
    this.ids.set(element, blockId);
    this.observer()?.observe(element);
    return () => {
      this.ids.delete(element);
      this.io?.unobserve(element);
    };
  }
}

export function useReadingViewport(
  observer: ScrollReadingObserver | undefined,
  insets: ReadingInsets,
): ReadingViewport {
  const [viewport] = useState(() => {
    // Configured at creation, so blocks that mount before this component's effect runs (children's
    // effects run first) already report to the observer; later changes arrive through the effect.
    const created = new WebReadingViewport();
    created.configure(observer, insets);
    return created;
  });
  useEffect(() => {
    viewport.configure(observer, insets);
  });
  return viewport;
}

/** Props for a block's wrapper view: on the web the wrapper's element is observed. */
export function useBlockReading(viewport: ReadingViewport, blockId: string): BlockReadingProps {
  useEffect(() => {
    viewport.blockMounted(blockId);
    return () => viewport.blockUnmounted(blockId);
  }, [viewport, blockId]);
  const detach = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (node: ViewInstance | null) => {
      detach.current?.();
      detach.current = null;
      // React Native Web hands out the DOM element itself.
      const element = node as unknown as Element | null;
      if (element !== null) detach.current = viewport.attach?.(blockId, element) ?? null;
    },
    [viewport, blockId],
  );
  return { ref };
}
