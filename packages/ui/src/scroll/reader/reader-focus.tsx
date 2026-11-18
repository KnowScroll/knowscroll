import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

/** Native: no keyboard layer (a keyboard attached to a phone uses the buttons); the group is just the reader's frame. */
export function ReaderFocus<Key>({
  children,
}: {
  readonly children: ReactNode;
  readonly keyOf: (key: string, shift: boolean) => Key | undefined;
  readonly onKey: (key: Key) => boolean;
}) {
  return <View style={styles.fill}>{children}</View>;
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
