import { useState } from 'react';
import type { ViewStyle } from 'react-native';
import { focusRing, type FocusTone } from '@knowscroll/design-tokens';

export interface FocusRing {
  /** Spread onto the focusable element. */
  readonly props: { onFocus: () => void; onBlur: () => void };
  /** The ring while focused; `undefined` otherwise. */
  readonly style: ViewStyle | undefined;
}

/**
 * Native: draw the focus ring while the element has (keyboard, switch or D-pad) focus. The web
 * implementation (`focus-ring.web.ts`) uses `:focus-visible` instead, so pointer clicks do not
 * draw it.
 */
export function useFocusRing(tone: FocusTone): FocusRing {
  const [focused, setFocused] = useState(false);
  const ring = focusRing[tone];
  return {
    props: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
    style: focused
      ? { outlineColor: ring.color, outlineWidth: ring.width, outlineOffset: ring.offset, outlineStyle: 'solid' }
      : undefined,
  };
}
