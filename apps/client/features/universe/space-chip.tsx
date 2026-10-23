import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, focusRing, overlay, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Text, type IconName } from '@knowscroll/ui';

/** The accent of the Lately dot: teal, the "active" colour of the library. */
const LATELY_DOT = '#14C79B';

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
  readonly testID?: string;
  readonly accessibilityLabel?: string;
}) {
  const [focused, setFocused] = useState(false);
  const solid = variant === 'solid';
  const foreground = solid ? space.onControl : space.label;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={toggled === undefined ? 'button' : 'togglebutton'}
      accessibilityLabel={accessibilityLabel ?? label}
      aria-checked={toggled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        styles.chip,
        solid ? styles.solid : styles.ghost,
        focused
          ? {
              outlineColor: focusRing.onDark.color,
              outlineWidth: focusRing.onDark.width,
              outlineOffset: focusRing.onDark.offset,
              outlineStyle: 'solid',
            }
          : null,
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={foreground} strokeWidth={2.2} /> : null}
      {dot === undefined ? null : (
        <View style={[styles.dot, { backgroundColor: dot ? LATELY_DOT : 'transparent', borderColor: dot ? LATELY_DOT : foreground }]} />
      )}
      <Text variant="uiS" color={foreground}>
        {label}
      </Text>
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
    cursor: 'pointer' as const,
  },
  solid: { backgroundColor: space.control },
  ghost: { borderWidth: borderWidth.hairline, borderColor: overlay.onDarkEdge },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1 },
});
