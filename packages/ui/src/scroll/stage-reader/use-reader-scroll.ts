import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollViewInstance,
  ScrollViewProps,
} from 'react-native';
import { currentSection, settleTarget } from './current-stop';
import { SNAPS_IN_SCRIPT, snapProps } from './snap';

/** How long a scroll must be still before the text settles on a nearby stop. */
const SETTLE_MS = 140;
/** A second key press this soon after the last one continues from where that one was heading. */
const KEY_REPEAT_MS = 800;
/** A reveal that is not laid out within this long of the lock is no longer waited for. */
const REVEAL_WAIT_MS = 1_000;
/** The pause that lets the grown section's own layout land before the reveal is brought on screen. */
const REVEAL_SETTLE_MS = 60;
/** How far past the end, in px, an overscroll counts as asking for a new topic (iOS; Android uses the button). */
const NATIVE_PULL = 72;

interface Metrics {
  scrollTop: number;
  viewport: number;
  content: number;
}

/**
 * The scrolling of a v2 Scroll's text: which section the reader is on, where each section starts,
 * jumping to one, and settling softly onto a stop when scrolling stops (D-134). The sections are
 * stacked, so a section's top is the running total of the heights above it: a layout event reports a
 * change of height reliably on every platform, but a change of position alone not on the web.
 */
export function useReaderScroll(input: {
  /** The text's scroll view, owned by the component that draws it. */
  readonly scroller: RefObject<ScrollViewInstance | null>;
  readonly sections: number;
  readonly startAt: number;
  readonly reducedMotion: boolean;
  readonly onPullPastEnd: (() => void) | undefined;
}) {
  const { scroller, sections, startAt, reducedMotion, onPullPastEnd } = input;
  const tops = useRef<number[]>([]);
  const heights = useRef<number[]>([]);
  const metrics = useRef<Metrics>({ scrollTop: 0, viewport: 0, content: 0 });
  const restored = useRef(false);
  const dragBeganAtEnd = useRef(false);
  /** The section whose call was just locked: once its reveal is laid out, the reveal is brought on screen. */
  const revealing = useRef<{ readonly index: number; readonly at: number } | undefined>(undefined);
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Where the last jump was heading, so quick key presses add up while the scroll is still travelling. */
  const aim = useRef({ index: startAt, at: 0 });
  const [current, setCurrent] = useState(startAt);
  const [offsets, setOffsets] = useState<readonly number[]>([]);
  const [viewport, setViewport] = useState(0);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(settling.current);
      clearTimeout(revealTimer.current);
    },
    [],
  );

  const jump = useCallback(
    (index: number, animated: boolean) => {
      const clamped = Math.max(0, Math.min(index, sections - 1));
      aim.current = { index: clamped, at: Date.now() };
      const y = tops.current[clamped];
      if (y !== undefined) scroller.current?.scrollTo({ y, animated: animated && !reducedMotion });
    },
    [scroller, reducedMotion, sections],
  );
  const revealIn = useCallback((index: number) => {
    revealing.current = { index, at: Date.now() };
  }, []);
  const heading = (): number => (Date.now() - aim.current.at < KEY_REPEAT_MS ? aim.current.index : current);
  const atEnd = useCallback(() => {
    const { scrollTop, viewport: visible, content } = metrics.current;
    return content > visible && scrollTop + visible >= content - 4;
  }, []);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    metrics.current = { scrollTop: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height };
    if (restored.current) {
      const next = currentSection({
        tops: tops.current,
        scrollTop: contentOffset.y,
        viewportHeight: layoutMeasurement.height,
        contentHeight: contentSize.height,
      });
      setCurrent((was) => (was === next ? was : next));
    }
    if (!SNAPS_IN_SCRIPT) return;
    clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      const target = settleTarget({ tops: tops.current, scrollTop: metrics.current.scrollTop, atEnd: atEnd() });
      if (target !== undefined) scroller.current?.scrollTo({ y: target, animated: !reducedMotion });
    }, SETTLE_MS);
  };

  /**
   * A locked call's reveal has been laid out, `revealHeight` tall (with the section's own bottom
   * padding). Brings it on screen, never scrolling back up: its end when it fits the view, otherwise
   * its start, so the "Called it!" or "Plot twist!" label is what the person sees first.
   */
  const reportReveal = (index: number, revealHeight: number) => {
    const waiting = revealing.current;
    if (waiting?.index !== index) return;
    revealing.current = undefined;
    if (Date.now() - waiting.at > REVEAL_WAIT_MS) return;
    clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => {
      const { scrollTop, viewport: visible } = metrics.current;
      const end = (tops.current[index] ?? 0) + (heights.current[index] ?? 0);
      const y = Math.min(end - visible, end - revealHeight);
      if (y > scrollTop) scroller.current?.scrollTo({ y, animated: !reducedMotion });
    }, REVEAL_SETTLE_MS);
  };

  /**
   * A section that grows (a call's answer is shown) moves every top below it, and its new height is
   * reported a frame after the change. A jump made in that frame went to the old top and landed short;
   * it is repeated to the new one. Later layout changes leave the reader's place alone.
   */
  const keepHeading = () => {
    if (Date.now() - aim.current.at >= KEY_REPEAT_MS) return;
    const y = tops.current[aim.current.index];
    if (y !== undefined && y !== metrics.current.scrollTop) scroller.current?.scrollTo({ y, animated: false });
  };

  const measureSection = (index: number) => (event: LayoutChangeEvent) => {
    heights.current[index] = event.nativeEvent.layout.height;
    if (heights.current.filter((height) => height !== undefined).length < sections) return;
    let top = 0;
    tops.current = heights.current.map((height) => {
      const at = top;
      top += height;
      return at;
    });
    setOffsets([...tops.current]);
    if (restored.current) {
      keepHeading();
      return;
    }
    restored.current = true;
    if (startAt > 0) scroller.current?.scrollTo({ y: tops.current[startAt] ?? 0, animated: false });
  };

  const scrollProps: ScrollViewProps = {
    scrollEventThrottle: 16,
    onScroll,
    onLayout: (event) => {
      metrics.current.viewport = event.nativeEvent.layout.height;
      setViewport(event.nativeEvent.layout.height);
    },
    onContentSizeChange: (_width, height) => {
      metrics.current.content = height;
    },
    // A pull is one that began at the very end: a drag that began mid-text and was flung past it is reading.
    onScrollBeginDrag: () => {
      dragBeganAtEnd.current = atEnd();
    },
    onScrollEndDrag: (event) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      const past = contentOffset.y + layoutMeasurement.height - contentSize.height;
      if (dragBeganAtEnd.current && past >= NATIVE_PULL) onPullPastEnd?.();
      dragBeganAtEnd.current = false;
    },
    ...snapProps(offsets),
  };
  return { current, viewport, jump, revealIn, reportReveal, heading, atEnd, measureSection, scrollProps };
}
