import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

/**
 * One option of a single-choice group (R03): the choice is shown by a filled dot, a heavier border and
 * an offset shadow, never by colour alone. It is a real radio: space or enter chooses it, and a screen
 * reader hears "radio button, checked".
 */
export function ChoiceRow({
  text,
  checked,
  disabled,
  onChoose,
  detail,
  accessibilityLabel,
  testID,
}: {
  readonly text: string;
  /** What belongs under the option's words, such as a poll's tally. */
  readonly detail?: ReactNode;
  /** The spoken name when it should say more than the words (a tally). */
  readonly accessibilityLabel?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChoose: () => void;
  readonly testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled === true}
      accessibilityRole="radio"
      accessibilityState={{ checked, disabled: disabled === true }}
      accessibilityLabel={accessibilityLabel ?? text}
      disabled={disabled === true}
      onPress={onChoose}
      style={[styles.row, checked ? styles.checked : null]}
    >
      <View style={[styles.dot, checked ? styles.dotChecked : null]} aria-hidden>
        {checked ? <View style={styles.dotCore} /> : null}
      </View>
      <View style={styles.text}>
        <Text variant="ui">{text}</Text>
        {detail}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  checked: { backgroundColor: content.paper2, boxShadow: elevation.press },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotChecked: { backgroundColor: content.paper },
  dotCore: { width: 10, height: 10, borderRadius: 5, backgroundColor: content.ink },
  text: { flex: 1, gap: spacing['1'] },
});
