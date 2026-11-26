/**
 * The small frame-rate figure over the Universe and the hook the drawing loop reports through. The meter's own maths is
 * in `frame-meter.ts`; this file only holds the one meter, shows it and hands the loop a way to feed it. Both reach the
 * main bundle, so neither may import three.js.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, space, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import {
  createFrameMeter,
  describeFrames,
  describeLegs,
  type FlightLeg,
  type FrameMeter,
  type FrameTime,
} from './frame-meter';

/** Carries the meter from the readout to the drawing loop below it; null when nobody is reading. */
const MeterContext = createContext<FrameMeter | null>(null);

/** How often the figure is redrawn. Slow on purpose: the readout must not cost what it measures. */
const REFRESH_MS = 500;

/**
 * The frame-rate readout over the Universe, when this device asked for it in Settings → Accessibility. Its children's
 * drawing loop reports each frame through {@link useFrameTimeRecorder}; without the setting nothing is recorded.
 *
 * It is drawn in the top right corner, unless `placed` says the screen below draws it itself with
 * {@link FrameRateFigure}, in its own layout, where nothing of the screen's lies under it.
 */
export function FrameRateReadout({
  on,
  placed = false,
  children,
}: {
  readonly on: boolean;
  readonly placed?: boolean;
  readonly children: ReactNode;
}) {
  const [meter] = useState(() => createFrameMeter());
  return (
    <MeterContext.Provider value={on ? meter : null}>
      {children}
      {on && !placed ? <Figure meter={meter} corner /> : null}
    </MeterContext.Provider>
  );
}

/**
 * The readout's figure, in the layout of whatever holds it, at its right edge: for a screen that told
 * {@link FrameRateReadout} it is `placed`. Nothing when nobody is reading.
 */
export function FrameRateFigure() {
  const meter = useContext(MeterContext);
  return meter === null ? null : <Figure meter={meter} />;
}

/** Where a drawing loop reports a frame, or undefined when nobody is reading. */
export function useFrameTimeRecorder(): ((frame: FrameTime) => void) | undefined {
  return useContext(MeterContext)?.record;
}

/** Where a camera reports a flight that has landed, or undefined when nobody is reading. */
export function useFlightRecorder(): ((leg: FlightLeg) => void) | undefined {
  return useContext(MeterContext)?.recordLeg;
}

/** Where the camera reports what the fingers did, or undefined when nobody is reading. */
export function useGestureRecorder(): ((line: string) => void) | undefined {
  return useContext(MeterContext)?.recordGesture;
}

/** What the figure says now: the last two seconds, a line for each of the last flights, and what the fingers did last. */
const describe = (meter: FrameMeter): string => {
  const gesture = meter.gesture();
  return [
    describeFrames(meter.summary(performance.now())),
    describeLegs(meter.legs()),
    gesture === null ? '' : `touch: ${gesture}`,
  ]
    .filter(Boolean)
    .join('\n');
};

/** The figures, refreshed every {@link REFRESH_MS}. */
function Figure({ meter, corner = false }: { readonly meter: FrameMeter; readonly corner?: boolean }) {
  const [line, setLine] = useState(() => describe(meter));
  useEffect(() => {
    const timer = setInterval(() => setLine(describe(meter)), REFRESH_MS);
    return () => clearInterval(timer);
  }, [meter]);
  return (
    <View
      pointerEvents="none"
      style={corner ? [styles.figure, styles.corner] : styles.figure}
      testID="universe-frame-rate"
    >
      <Text variant="meta" color={space.label} align="right">
        {line}
      </Text>
    </View>
  );
}

/** Distance from the top in layout points of the corner placement: level with the search and Lately chips, below the header's avatar. */
const FIGURE_TOP = 76;
/** The sky's near-black at 72%: dark enough for the small text to read over bright stars. Used nowhere else. */
const FIGURE_BACKGROUND = 'rgba(2, 3, 8, 0.72)';

const styles = StyleSheet.create({
  corner: { position: 'absolute', right: spacing[4], top: FIGURE_TOP, borderRadius: radius.pill },
  figure: {
    alignSelf: 'flex-end',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    // Not a pill: its lines are several, and a pill's corners leave the ends of the longest lines on the bare sky.
    borderRadius: radius.md,
    backgroundColor: FIGURE_BACKGROUND,
  },
});
