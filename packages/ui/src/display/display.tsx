import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useWindowDimensions } from 'react-native';
import { breakpointFor, type Breakpoint } from '@knowscroll/design-tokens';

/** What the layout depends on: window width, the system text size and the motion preference. */
export interface Display {
  readonly width: number;
  readonly breakpoint: Breakpoint;
  /** System text size, 1 = 100 %. */
  readonly textScale: number;
  readonly reducedMotion: boolean;
}

type DisplayOverride = Partial<Pick<Display, 'width' | 'textScale' | 'reducedMotion'>>;

const DisplayOverrideContext = createContext<DisplayOverride | null>(null);

/**
 * Pins parts of the display for the subtree: the component gallery previews a breakpoint or a
 * text size side by side, and tests choose them instead of inheriting the host's.
 */
export function DisplayProvider({ value, children }: { value: DisplayOverride; children: ReactNode }) {
  const parent = useContext(DisplayOverrideContext);
  return <DisplayOverrideContext.Provider value={{ ...parent, ...value }}>{children}</DisplayOverrideContext.Provider>;
}

/** Follows the system "reduce motion" setting (on the web: `prefers-reduced-motion`). */
function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (active) setReduced(value);
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

export function useDisplay(): Display {
  const override = useContext(DisplayOverrideContext);
  const window = useWindowDimensions();
  const systemReducedMotion = useSystemReducedMotion();
  const width = override?.width ?? window.width;
  return {
    width,
    breakpoint: breakpointFor(width),
    textScale: override?.textScale ?? window.fontScale,
    reducedMotion: override?.reducedMotion ?? systemReducedMotion,
  };
}
