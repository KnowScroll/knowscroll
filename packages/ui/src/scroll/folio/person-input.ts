import type { RefObject } from 'react';

/**
 * Native: nothing here. A touch that starts a drag is the person's input, and reaches the reader as the scroller's
 * `onScrollBeginDrag`.
 */
export function usePersonInput(_scroller: RefObject<unknown>, _onInput: () => void): void {}

/** Native: nothing to do; a finger on a scroll view stops its own animation. */
export function stopScrolling(_scroller: RefObject<unknown>): void {}
