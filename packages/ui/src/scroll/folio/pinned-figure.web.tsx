import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { ScrollOffset } from './scroll-offset';

/** The browser pins it: `position: sticky` lets go at the end of its own hold, which is the behaviour a hold needs. */
const STICKY = { position: 'sticky', top: 0, zIndex: 2 } as unknown as ViewStyle;

/** Web: a hold's figure kept at the top of the viewport by the browser itself, with no script on the scroll path. */
export function PinnedFigure({
  style,
  children,
}: {
  readonly offset: ScrollOffset;
  readonly holdTop: number;
  readonly travel: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  return <View style={[style, STICKY]}>{children}</View>;
}
