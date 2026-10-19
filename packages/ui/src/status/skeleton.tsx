import { useEffect, useState } from 'react';
import { Animated, Platform, StyleSheet, View, type DimensionValue } from 'react-native';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import { useDisplay } from '../display/display';

/**
 * Loading placeholders (not drawn in the export; composed from paper-2 and the card radius).
 * They pulse gently; under reduced motion they hold still. Loading is not "preparing": content
 * that is being made uses the pending stripe instead.
 */
export interface SkeletonProps {
  /** Number of card placeholders. */
  readonly rows?: number;
  /** Accessible name of the busy region. */
  readonly label?: string;
}

function Bar({ width, height }: { width: DimensionValue; height: number }) {
  return <View style={[styles.bar, { width, height }]} />;
}

export function Skeleton({ rows = 3, label = 'Loading' }: SkeletonProps) {
  const { reducedMotion } = useDisplay();
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.55, duration: 900, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reducedMotion]);
  return (
    <View role="progressbar" accessible accessibilityLabel={label} aria-busy style={styles.list}>
      {Array.from({ length: rows }, (_, index) => (
        <Animated.View key={index} style={[styles.card, { opacity: pulse }]}>
          <View style={styles.thumb} />
          <View style={styles.lines}>
            <Bar width="35%" height={14} />
            <Bar width="85%" height={18} />
            <Bar width="55%" height={14} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[3] },
  card: {
    flexDirection: 'row',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radius.card,
    backgroundColor: content.paper,
    borderWidth: 2,
    borderColor: content.paper2,
  },
  thumb: { width: 64, height: 64, borderRadius: radius.md, backgroundColor: content.paper2 },
  lines: { flex: 1, gap: spacing[2], justifyContent: 'center' },
  bar: { borderRadius: radius.xs, backgroundColor: content.paper2 },
});
