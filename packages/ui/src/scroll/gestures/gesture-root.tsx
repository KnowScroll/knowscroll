import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

/**
 * Native: the root every gesture detector needs. The article carries its own, so a route does not
 * have to mount one for Scroll blocks to take gestures. The web file is a plain view.
 */
export function GestureRoot({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <GestureHandlerRootView style={style}>{children}</GestureHandlerRootView>;
}
