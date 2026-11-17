import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ReaderKey } from './reader-keys';

/** Native: no keyboard layer (a keyboard attached to a phone uses the buttons); the group is just the reader's frame. */
export function ReaderFocus({
  children,
}: {
  readonly children: ReactNode;
  readonly onKey: (key: ReaderKey) => boolean;
}) {
  return <View style={styles.fill}>{children}</View>;
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
