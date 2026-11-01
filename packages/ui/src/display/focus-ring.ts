import { useState } from 'react';
import type { ViewStyle } from 'react-native';
import { focusHalo, focusRing, type FocusTone } from '@knowscroll/design-tokens';
import { useFocusHalo } from './focus-halo';

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
  const halo = useFocusHalo();
  const haloColour = tone === 'onLight' && halo !== undefined ? focusHalo[halo] : undefined;
  return {
    props: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
    style: focused
      ? {
          outlineColor: ring.color,
          outlineWidth: ring.width,
          outlineOffset: ring.offset,
          outlineStyle: 'solid',
          ...(haloColour === undefined
            ? {}
            : {
                boxShadow: [
                  {
                    offsetX: 0,
                    offsetY: 0,
                    blurRadius: 0,
                    spreadDistance: ring.offset + ring.width + focusHalo.extra,
                    color: haloColour,
                  },
                ],
              }),
        }
      : undefined,
  };
}
