import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, space, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { createFrameMeter, describeFrames, type FrameMeter, type FrameTime } from './frame-meter';

const MeterContext = createContext<FrameMeter | null>(null);

/** How often the figure is redrawn. Slow on purpose: the readout must not cost what it measures. */
const REFRESH_MS = 500;

/**
 * The frame-rate readout over the Universe, when this device asked for it in Settings → Accessibility. Its children's
 * drawing loop reports each frame through {@link useFrameTimeRecorder}; without the setting nothing is recorded.
 */
export function FrameRateReadout({ on, children }: { readonly on: boolean; readonly children: ReactNode }) {
  const meter = useMemo(() => (on ? createFrameMeter() : null), [on]);
  return (
    <MeterContext.Provider value={meter}>
      {children}
      {meter ? <Figure meter={meter} /> : null}
    </MeterContext.Provider>
  );
}

/** Where a drawing loop reports a frame, or undefined when nobody is reading. */
export function useFrameTimeRecorder(): ((frame: FrameTime) => void) | undefined {
  const meter = useContext(MeterContext);
  return useMemo(() => (meter ? (frame: FrameTime) => meter.record(frame) : undefined), [meter]);
}

function Figure({ meter }: { readonly meter: FrameMeter }) {
  const [line, setLine] = useState(() => describeFrames(meter.summary(performance.now())));
  useEffect(() => {
    const timer = setInterval(() => setLine(describeFrames(meter.summary(performance.now()))), REFRESH_MS);
    return () => clearInterval(timer);
  }, [meter]);
  return (
    <View pointerEvents="none" style={styles.figure} testID="universe-frame-rate">
      <Text variant="meta" color={space.label}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  figure: {
    position: 'absolute',
    left: spacing[4],
    // Below the header's title and Back pill.
    top: 76,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    backgroundColor: 'rgba(2, 3, 8, 0.72)',
  },
});
