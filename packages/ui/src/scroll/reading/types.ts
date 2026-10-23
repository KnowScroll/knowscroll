import type { PositionBinding, ScrollLocalPosition } from './local-position';
import type { LayoutChangeEvent, ScrollViewProps, ViewInstance } from 'react-native';

/** Space the article's own chrome covers at the top and bottom of the scrolling area. */
export interface ReadingInsets {
  readonly top: number;
  readonly bottom: number;
}

/**
 * Measures what the reader can see. Native (`reading-viewport.ts`) works from layout and scroll
 * offset; the web (`reading-viewport.web.ts`) from IntersectionObserver. Both report through the
 * same tracker (`visibility.ts`), so one rule decides what a visibility event is.
 */
export interface ReadingViewport {
  /** Props for the article's vertical `ScrollView`. */
  readonly scrollProps: Pick<
    ScrollViewProps,
    'onScroll' | 'onLayout' | 'scrollEventThrottle' | 'onContentSizeChange' | 'onScrollBeginDrag'
  >;
  bindPosition(binding: PositionBinding): void;
  capturePosition(): Pick<ScrollLocalPosition, 'blockId' | 'offsetWithinBlock'> | null;
  disposePosition(): void;
  blockMounted(blockId: string): void;
  blockUnmounted(blockId: string): void;
  /** Native: a block's layout inside the scroll content. */
  blockLaidOut(blockId: string, top: number, height: number): void;
  /** Web: start observing a block's element; returns the function that stops. */
  attach?(blockId: string, element: Element): () => void;
}

/** Props a block's wrapper view takes to be measured: native a layout handler, web a ref. */
export interface BlockReadingProps {
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly ref?: (node: ViewInstance | null) => void;
}
