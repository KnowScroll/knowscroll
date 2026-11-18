import { Animated } from 'react-native';

/**
 * The essay's scroll offset and viewport height, for the parts that follow the scroll (a hold's figure and its
 * state) without re-rendering the whole reader on every frame. `animated` carries the same offset as an Animated value,
 * which native drives on the UI thread so a pinned figure never lags the text.
 */
export interface ScrollOffset {
  readonly animated: Animated.Value;
  readonly current: () => { readonly top: number; readonly viewport: number };
  readonly subscribe: (listener: () => void) => () => void;
  readonly update: (top: number, viewport: number) => void;
}

export function createScrollOffset(): ScrollOffset {
  const animated = new Animated.Value(0);
  const listeners = new Set<() => void>();
  let state = { top: 0, viewport: 0 };
  return {
    animated,
    current: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(top, viewport) {
      if (top === state.top && viewport === state.viewport) return;
      state = { top, viewport };
      for (const listener of listeners) listener();
    },
  };
}
