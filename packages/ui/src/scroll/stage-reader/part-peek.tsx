import { Animated, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';
import type { NextPartPeek } from './end-tray';
import { SWIPE_DISTANCE } from './part-gesture';

/** The bar fills to this many times the distance a release needs, so the notch sits at two thirds of it. */
const BAR_SPAN = 1.5;

/** Which Part the finger is bringing: the next one from the right, the one before from the left. */
export type PeekSide = 'next' | 'previous';

/**
 * The Part a sideways drag is bringing in (V3 G2, E1 "dragging into Part 2"): a panel that follows the finger
 * from the edge it waits at, with a bar along its top that fills as the drag goes on and a notch where a release
 * counts. What it carries is what is known before the Part is opened (its label and title), never its text. It is
 * the picture of the move for the eye alone: the move itself is the dock's button, the arrow keys and the swipe, so
 * this takes no press and is hidden from assistive technology. Under reduced motion it is not drawn at all.
 *
 * `dx` is the finger's travel in px (negative for the next Part, positive for the one before) and is read by the
 * animation, not by React, so a drag redraws nothing but this panel.
 */
export function PartPeekPanel({
  side,
  peek,
  dx,
  width,
  past,
}: {
  readonly side: PeekSide;
  readonly peek: NextPartPeek;
  readonly dx: Animated.Value;
  /** The width of the area the panel covers. */
  readonly width: number;
  /** The drag is past the notch: a release would move. */
  readonly past: boolean;
}) {
  const next = side === 'next';
  const travel = next
    ? dx.interpolate({ inputRange: [-width, 0], outputRange: [0, width], extrapolate: 'clamp' })
    : dx.interpolate({ inputRange: [0, width], outputRange: [-width, 0], extrapolate: 'clamp' });
  const filled = dx.interpolate({
    inputRange: next ? [-SWIPE_DISTANCE * BAR_SPAN, 0] : [0, SWIPE_DISTANCE * BAR_SPAN],
    outputRange: next ? ['100%', '0%'] : ['0%', '100%'],
    extrapolate: 'clamp',
  });
  const words = past
    ? 'PAST THE NOTCH · LET GO TO CONTINUE'
    : next
      ? `KEEP GOING · ${peek.label.toUpperCase()}`
      : `KEEP GOING · BACK TO ${peek.label.toUpperCase()}`;
  return (
    <Animated.View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID="part-peek-panel"
      style={[styles.panel, { width, transform: [{ translateX: travel }] }, next ? styles.fromRight : styles.fromLeft]}
    >
      <View style={styles.bar}>
        <Animated.View style={[styles.fill, { width: filled }]} />
        <View style={[styles.notch, { left: `${String(Math.round(100 / BAR_SPAN))}%` }]} />
      </View>
      <Text variant="monoXs" color={content.ink2} testID="part-peek-words">
        {words}
      </Text>
      <View style={styles.card}>
        <Tag label={peek.label} variant="part" />
        <Text variant="title" heading={2}>
          {peek.title}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    gap: spacing[3],
    padding: spacing[5],
    backgroundColor: content.paper,
    borderColor: content.ink,
  },
  fromRight: { left: 0, borderLeftWidth: borderWidth.regular },
  fromLeft: { left: 0, borderRightWidth: borderWidth.regular },
  bar: {
    height: 10,
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: content.accent },
  notch: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: content.ink },
  card: {
    gap: spacing[2],
    alignItems: 'flex-start',
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
});
