import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, overlay, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Text, toggleSemantics, useFocusRing, type IconName } from '@knowscroll/ui';

/** The accent of the Lately dot: teal, the "active" colour of the library. */
const LATELY_DOT = '#14C79B';
/** The new look's ghost fill (the prototype's `.ksu-ghost`): dark glass, so the label reads over pale land. */
const GLASS_FILL = 'rgba(10,20,28,0.55)';

/**
 * The pill controls drawn on the map (`pillsp` / `pillgh` in the artboards): cream and solid, or
 * outlined on the sky. 44 px tall, so the thumb always lands.
 */
export function SpaceChip({
  label,
  onPress,
  variant = 'ghost',
  icon,
  trailingIcon,
  dot,
  toggled,
  glass,
  testID,
  accessibilityLabel,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'solid' | 'ghost';
  readonly icon?: IconName;
  readonly trailingIcon?: IconName;
  /** A leading dot, lit while a lens is on. */
  readonly dot?: boolean;
  /** A two-state chip (the Lately lens). */
  readonly toggled?: boolean;
  /** The new look's ghost chip: it takes a dark glass fill so it reads over pale land. Ignored on a solid chip. */
  readonly glass?: boolean;
  readonly testID?: string;
  readonly accessibilityLabel?: string;
}) {
  const focus = useFocusRing('onDark');
  const solid = variant === 'solid';
  const foreground = solid ? space.onControl : space.label;
  return (
    <Pressable
      testID={testID}
      {...(toggled === undefined ? { accessibilityRole: 'button' as const } : toggleSemantics(toggled))}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      {...focus.props}
      style={[styles.chip, solid ? styles.solid : styles.ghost, glass && !solid ? styles.glass : null, focus.style]}
    >
      {icon ? <Icon name={icon} size={16} color={foreground} strokeWidth={2.2} /> : null}
      {dot === undefined ? null : (
        <View
          style={[
            styles.dot,
            { backgroundColor: dot ? LATELY_DOT : 'transparent', borderColor: dot ? LATELY_DOT : foreground },
          ]}
        />
      )}
      <View style={styles.label}>
        <Text variant="uiS" color={foreground} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {trailingIcon ? <Icon name={trailingIcon} size={16} color={foreground} strokeWidth={2.4} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: target.minimum,
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    maxWidth: '100%',
    flexShrink: 1,
    cursor: 'pointer' as const,
  },
  solid: { backgroundColor: space.control },
  ghost: { borderWidth: borderWidth.hairline, borderColor: overlay.onDarkEdge },
  glass: { backgroundColor: GLASS_FILL },
  /** A long name shortens with an ellipsis instead of leaving the screen; the accessible name stays whole. */
  label: { flexShrink: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1 },
});
