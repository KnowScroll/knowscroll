import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Dimensions, useWindowDimensions } from 'react-native';
import { breakpointFor, type Breakpoint } from '@knowscroll/design-tokens';

/** What the layout depends on: window width, the system text size and the motion preference. */
export interface Display {
  readonly width: number;
  readonly breakpoint: Breakpoint;
  /** System text size, 1 = 100 %. */
  readonly textScale: number;
  readonly reducedMotion: boolean;
}

type DisplayInputs = Pick<Display, 'width' | 'textScale' | 'reducedMotion'>;

const DisplayContext = createContext<DisplayInputs | null>(null);

function toDisplay(inputs: DisplayInputs): Display {
  return { ...inputs, breakpoint: breakpointFor(inputs.width) };
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

function SystemDisplay({ children }: { children: ReactNode }) {
  const window = useWindowDimensions();
  const reducedMotion = useSystemReducedMotion();
  const value = useMemo(
    () => ({ width: window.width, textScale: window.fontScale, reducedMotion }),
    [window.width, window.fontScale, reducedMotion],
  );
  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

/**
 * Reads the window, the system text size and the reduce-motion setting once, for the whole app.
 * Mount it at the root: every component then reads the context instead of subscribing itself.
 * Inside a display that is already set (a test or a preview pinning one), it keeps that display.
 */
export function DisplayRoot({ children }: { children: ReactNode }) {
  const outer = useContext(DisplayContext);
  if (outer !== null) return <>{children}</>;
  return <SystemDisplay>{children}</SystemDisplay>;
}

/**
 * Pins parts of the display for the subtree: the component gallery previews a breakpoint or a
 * text size side by side, and tests choose them instead of inheriting the host's.
 */
export function DisplayProvider({ value, children }: { value: Partial<DisplayInputs>; children: ReactNode }) {
  const parent = useContext(DisplayContext) ?? fallbackInputs();
  const merged = useMemo(
    () => ({
      width: value.width ?? parent.width,
      textScale: value.textScale ?? parent.textScale,
      reducedMotion: value.reducedMotion ?? parent.reducedMotion,
    }),
    [parent.width, parent.textScale, parent.reducedMotion, value.width, value.textScale, value.reducedMotion],
  );
  return <DisplayContext.Provider value={merged}>{children}</DisplayContext.Provider>;
}

/** Without a `DisplayRoot`: the window as it is now, 100 % text, motion on. Nothing subscribes. */
function fallbackInputs(): DisplayInputs {
  return { width: Dimensions.get('window').width, textScale: 1, reducedMotion: false };
}

/** The display, read from the nearest `DisplayRoot` or `DisplayProvider`; never subscribes itself. */
export function useDisplay(): Display {
  const inputs = useContext(DisplayContext);
  return toDisplay(inputs ?? fallbackInputs());
}
