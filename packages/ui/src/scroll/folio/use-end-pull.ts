import type { RefObject } from 'react';
import type { Animated } from 'react-native';

/**
 * Native: no pull yet. Android's scroll view has no overscroll to read, and the iPhone runs the web app (#740); Next idea
 * and the N key move on there.
 */
export function useEndPull(
  _scroller: RefObject<unknown>,
  _onPull: (() => void) | undefined,
): Animated.Value | undefined {
  return undefined;
}
