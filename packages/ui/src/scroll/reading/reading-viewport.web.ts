import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewInstance } from 'react-native';
import type { ScrollReadingObserver } from '../observer';
import type { BlockReadingProps, ReadingInsets, ReadingViewport } from './types';
import { createVisibilityTracker, monotonicNow, type VisibilityTracker } from './visibility';

/** Every tenth of the visible fraction: the tracker decides which changes are events. */
const TENTHS = Array.from({ length: 11 }, (_, index) => index / 10);

/** The nearest ancestor that scrolls vertically (the article's scroller), or null for the page itself. */
function scrollerOf(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) return null;
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
  }
  return null;
}

interface Watched {
  readonly element: Element;
  io: IntersectionObserver | null;
  root: Element | null;
  /** The block's height when its observer was built (the thresholds depend on it). */
  height: number;
}

/**
 * Web: IntersectionObserver per block. The visible fraction is relative to `min(blockHeight,
 * readingHeight)` (so a block taller than the screen can reach 1), which an observer that reports
 * the raw ratio cannot give with fixed thresholds: the raw ratio of a block `k` times taller than
 * the reading area peaks at `1/k`, and fixed tenths would never see it fill the screen. Each block
 * therefore gets its own thresholds (`t / k` for the tenths `t`, rebuilt when the block or the
 * scroller resizes), the article's own scroller as the root (so the reading area is what the
 * reader sees, not the browser window), and the fraction is computed from the entry's rectangles.
 */
class WebReadingViewport implements ReadingViewport {
  readonly scrollProps = {};
  private readonly tracker: VisibilityTracker;
  private readonly watched = new Map<string, Watched>();
  private resizer: ResizeObserver | null = null;

  private observerOf: ScrollReadingObserver | undefined;
  private insets: ReadingInsets = { top: 0, bottom: 0 };
  /** The insets the current observers were built with. */
  private built: ReadingInsets = { top: 0, bottom: 0 };

  constructor() {
    this.tracker = createVisibilityTracker(() => this.observerOf, monotonicNow);
  }

  /** The latest observer and insets (set after every render, read when events arrive). */
  configure(observer: ScrollReadingObserver | undefined, insets: ReadingInsets): void {
    const replaced = this.observerOf !== observer;
    this.observerOf = observer;
    this.insets = insets;
    if (replaced) this.tracker.replay();
    if (insets.top !== this.built.top || insets.bottom !== this.built.bottom) {
      this.built = insets;
      for (const blockId of this.watched.keys()) this.observe(blockId);
    }
  }

  private observe(blockId: string): void {
    const watched = this.watched.get(blockId);
    if (watched === undefined || typeof IntersectionObserver === 'undefined') return;
    watched.io?.disconnect();
    const { top, bottom } = this.built;
    const root = scrollerOf(watched.element);
    const height = watched.element.getBoundingClientRect().height;
    const rootHeight = root === null ? window.innerHeight : root.clientHeight;
    const reading = rootHeight - top - bottom;
    // How many times taller than the reading area the block is (1 when it fits).
    const factor = reading > 0 && height > reading ? height / reading : 1;
    const thresholds = TENTHS.map((tenth) => tenth / factor);
    watched.root = root;
    watched.height = height;
    watched.io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined || this.watched.get(blockId) !== watched) return;
        const readingHeight = entry.rootBounds === null ? reading : entry.rootBounds.height;
        const denominator = Math.min(entry.boundingClientRect.height, readingHeight);
        const fraction = entry.isIntersecting && denominator > 0 ? entry.intersectionRect.height / denominator : 0;
        this.tracker.measured(blockId, fraction);
      },
      { root, rootMargin: `${-top}px 0px ${-bottom}px 0px`, threshold: thresholds },
    );
    watched.io.observe(watched.element);
    this.resizeWatch(watched);
  }

  /** Rebuild a block's thresholds when it or its scroller changes size. */
  private resizeWatch(watched: Watched): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizer ??= new ResizeObserver((entries) => {
      const changed = new Set<Element>(entries.map((entry) => entry.target));
      for (const [blockId, block] of this.watched) {
        const resized =
          changed.has(block.element) ||
          (block.root !== null && changed.has(block.root)) ||
          Math.abs(block.element.getBoundingClientRect().height - block.height) >= 1;
        if (resized) this.observe(blockId);
      }
    });
    this.resizer.observe(watched.element);
    if (watched.root !== null) this.resizer.observe(watched.root);
  }

  blockMounted(blockId: string): void {
    this.tracker.mounted(blockId, 0);
  }

  blockUnmounted(blockId: string): void {
    this.tracker.unmounted(blockId);
  }

  blockLaidOut(): void {}

  attach(blockId: string, element: Element): () => void {
    const watched: Watched = { element, io: null, root: null, height: 0 };
    this.watched.set(blockId, watched);
    this.observe(blockId);
    return () => {
      if (this.watched.get(blockId) === watched) this.watched.delete(blockId);
      watched.io?.disconnect();
      watched.io = null;
      this.resizer?.unobserve(element);
      if (this.watched.size === 0) {
        this.resizer?.disconnect();
        this.resizer = null;
      }
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
