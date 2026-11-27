import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, overlay, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Text, toggleSemantics, useFocusRing } from '@knowscroll/ui';

/** The chip's accessible name in every state: `aria-pressed` carries whether it is on. */
export const IN_COMMON_NAME = 'What we have in common';

/** The words the chip shows. It names no number: what you share is shown on the map, not counted. */
export function inCommonLabel(on: boolean, nothingShared: boolean): string {
  if (!on) return IN_COMMON_NAME;
  return nothingShared ? 'Nothing in common yet' : 'Showing what you share';
}

/**
 * "What we have in common", the chip at the whole-universe stop of a friend's Universe (Round 7.3): a two-state button,
 * outlined while off and cream while on. It stands as tall as a target (48 px: react-native-web ignores `hitSlop`, so
 * the pill itself is the target) and takes the keyboard like any button. A toggle keeps one name: the pressed state says whether it is on, and only the
 * words it shows change.
 */
export function InCommonChip({
  on,
  nothingShared,
  onToggle,
}: {
  readonly on: boolean;
  /** You share no name with this friend: said in the chip, and nothing on the map is dimmed. */
  readonly nothingShared: boolean;
  readonly onToggle: () => void;
}) {
  const focus = useFocusRing('onDark');
  const label = inCommonLabel(on, nothingShared);
  return (
    <Pressable
      testID="visit-in-common"
      {...toggleSemantics(on)}
      accessibilityLabel={IN_COMMON_NAME}
      onPress={onToggle}
      {...focus.props}
      style={[styles.chip, on ? styles.on : styles.off, focus.style]}
    >
      <View style={styles.label}>
        <Text variant="uiS" color={on ? space.onControl : space.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: target.comfortable,
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    maxWidth: '100%',
    flexShrink: 1,
    cursor: 'pointer' as const,
  },
  on: { backgroundColor: space.control },
  off: { borderWidth: borderWidth.hairline, borderColor: overlay.onDarkEdge },
  label: { flexShrink: 1, minWidth: 0 },
});
