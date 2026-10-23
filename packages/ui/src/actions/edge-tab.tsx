import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { Icon } from '../icons/icon';
import { Text } from '../text/text';

/**
 * `part`: a declared series step, solid yellow (the only yellow in the encounter, D-006 b).
 * `related`: another angle, dashed cream. `previous`: the step before in this thread, ink.
 */
export type EdgeTabKind = 'part' | 'related' | 'previous';

export interface EdgeTabProps {
  readonly kind: EdgeTabKind;
  /** Short mono label: "Part 2", "Related". */
  readonly label: string;
  /** Names the destination: "Continue: Part 2, Attention at work". The arrow alone says nothing. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly testID?: string;
}

const looks: Record<EdgeTabKind, { background: string; foreground: string; border: ViewStyle }> = {
  part: {
    background: content.continue,
    foreground: content.onContinue,
    border: { borderColor: content.ink, borderStyle: 'solid' },
  },
  related: {
    background: content.paper,
    foreground: content.ink,
    border: { borderColor: content.ink, borderStyle: 'dashed' },
  },
  previous: {
    background: content.nav,
    foreground: content.paper,
    border: { borderColor: content.nav, borderStyle: 'solid' },
  },
};

/**
 * The continuation tab on the edge of a Reel or Scroll (E01, E05): the arrow points to where the
 * move goes. Next moves sit on the end edge; the previous step on the start edge. It is a button
 * outside the stage's swipe handling, so a swipe and a tap do the same thing.
 */
export function EdgeTab({ kind, label, accessibilityLabel, onPress, disabled = false, testID }: EdgeTabProps) {
  const look = looks[kind];
  const focus = useFocusRing('onDark');
  const previous = kind === 'previous';
  return (
    <Pressable
      {...focus.props}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      aria-disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={[
        styles.tab,
        look.border,
        previous ? styles.previous : styles.next,
        { backgroundColor: look.background },
        disabled ? styles.disabled : null,
        focus.style,
      ]}
    >
      <Text variant="monoXs" color={look.foreground}>
        {label}
      </Text>
      <View>
        <Icon name={previous ? 'arrowLeft' : 'arrowRight'} size={22} color={look.foreground} strokeWidth={2.4} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tab: {
    minWidth: 64,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    borderWidth: borderWidth.regular,
    cursor: 'pointer' as const,
  },
  next: { borderRightWidth: 0, borderTopLeftRadius: radius.edgeTab, borderBottomLeftRadius: radius.edgeTab },
  previous: { borderLeftWidth: 0, borderTopRightRadius: radius.edgeTab, borderBottomRightRadius: radius.edgeTab },
  disabled: { opacity: 0.45 },
});
