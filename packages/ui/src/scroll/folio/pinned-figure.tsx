import type { ReactNode } from 'react';
import { Animated, type StyleProp, type ViewStyle } from 'react-native';
import type { ScrollOffset } from './scroll-offset';

/**
 * Native: a hold's figure kept at the top of the viewport by pushing it down its hold as the essay scrolls, from the
 * offset the UI thread drives. It moves with the scroll from the moment the hold's top reaches the top of the viewport
 * until it meets the hold's end, then leaves with the hold: a sticky header that lets go at the end of its own section,
 * which React Native's `stickyHeaderIndices` cannot do (its header lets go only when the next one arrives). `holdTop`
 * and `travel` come from layout: where the hold starts in the essay, and how far the figure can move.
 */
export function PinnedFigure({
  offset,
  holdTop,
  travel,
  style,
  children,
}: {
  readonly offset: ScrollOffset;
  readonly holdTop: number;
  readonly travel: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  const translateY =
    travel > 0
      ? offset.animated.interpolate({
          inputRange: [holdTop, holdTop + travel],
          outputRange: [0, travel],
          extrapolate: 'clamp',
        })
      : 0;
  return <Animated.View style={[style, { zIndex: 2, transform: [{ translateY }] }]}>{children}</Animated.View>;
}
