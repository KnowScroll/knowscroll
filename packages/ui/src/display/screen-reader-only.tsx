import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Words for assistive tech alone: in the accessibility tree, out of sight. A one-pixel box that clips its content, the
 * usual technique on the web; a native screen reader reads an element whatever its size.
 */
export function ScreenReaderOnly({ children }: { readonly children: ReactNode }) {
  return <View style={styles.hidden}>{children}</View>;
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden' },
});
