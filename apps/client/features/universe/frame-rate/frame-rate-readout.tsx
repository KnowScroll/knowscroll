/**
 * The small frame-rate figure over the Universe and the hook the drawing loop reports through. The meter's own maths is
 * in `frame-meter.ts`; this file only holds the one meter, shows it and hands the loop a way to feed it. Both reach the
 * main bundle, so neither may import three.js.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, space, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { createFrameMeter, describeFrames, type FrameMeter, type FrameTime } from './frame-meter';

/** Carries the meter from the readout to the drawing loop below it; null when nobody is reading. */
const MeterContext = createContext<FrameMeter | null>(null);

/** How often the figure is redrawn. Slow on purpose: the readout must not cost what it measures. */
const REFRESH_MS = 500;

/**
 * The frame-rate readout over the Universe, when this device asked for it in Settings → Accessibility. Its children's
 * drawing loop reports each frame through {@link useFrameTimeRecorder}; without the setting nothing is recorded.
 */
export function FrameRateReadout({ on, children }: { readonly on: boolean; readonly children: ReactNode }) {
  const [meter] = useState(() => createFrameMeter());
  return (
    <MeterContext.Provider value={on ? meter : null}>
      {children}
      {on ? <Figure meter={meter} /> : null}
    </MeterContext.Provider>
  );
}

/** Where a drawing loop reports a frame, or undefined when nobody is reading. */
export function useFrameTimeRecorder(): ((frame: FrameTime) => void) | undefined {
  return useContext(MeterContext)?.record;
}

/** The two lines of figures, refreshed every {@link REFRESH_MS}. */
function Figure({ meter }: { readonly meter: FrameMeter }) {
  const [line, setLine] = useState(() => describeFrames(meter.summary(performance.now())));
  useEffect(() => {
    const timer = setInterval(() => setLine(describeFrames(meter.summary(performance.now()))), REFRESH_MS);
    return () => clearInterval(timer);
  }, [meter]);
  return (
    <View pointerEvents="none" style={styles.figure} testID="universe-frame-rate">
      <Text variant="meta" color={space.label} align="right">
        {line}
      </Text>
    </View>
  );
}

/** Distance from the top in layout points: level with the search and Lately chips, below the header's avatar. */
const FIGURE_TOP = 76;
/** The sky's near-black at 72%: dark enough for the small text to read over bright stars. Used nowhere else. */
const FIGURE_BACKGROUND = 'rgba(2, 3, 8, 0.72)';

const styles = StyleSheet.create({
  figure: {
    position: 'absolute',
    right: spacing[4],
    top: FIGURE_TOP,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    backgroundColor: FIGURE_BACKGROUND,
  },
});
