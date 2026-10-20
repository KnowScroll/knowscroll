import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { borderWidth, content, elevation, focusRing, radius, spacing } from '@knowscroll/design-tokens';
import type { ViewProps } from 'react-native';

/** The framed surface interactive and reference blocks sit in (`.blk` in the export). */
export function BlockFrame({
  children,
  style,
  accessibilityLabel,
  description,
  hero = false,
  active = false,
  testID,
}: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  /** The block's accessible name; the frame is then a labelled group. */
  readonly accessibilityLabel?: string;
  readonly description?: string;
  /** The cobalt offset shadow of the Scroll diagram block and the hero card. */
  readonly hero?: boolean;
  /** A drag is in progress inside the block: a cobalt ring (never the continuation yellow, D-006 b). */
  readonly active?: boolean;
  readonly testID?: string;
}) {
  const labelled: Pick<ViewProps, 'role' | 'accessibilityLabel' | 'accessibilityHint'> =
    accessibilityLabel === undefined
      ? {}
      : { role: 'group', accessibilityLabel, ...(description === undefined ? {} : { accessibilityHint: description }) };
  return (
    <View
      testID={testID}
      {...labelled}
      style={[styles.frame, hero ? styles.hero : null, active ? styles.active : null, style]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    gap: spacing[3],
    padding: spacing['3.5'],
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  hero: { boxShadow: elevation.hero },
  active: { boxShadow: `0px 0px 0px ${focusRing.onLight.width}px ${focusRing.onLight.color}` },
});
