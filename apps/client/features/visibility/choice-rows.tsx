import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Text, useFocusRing } from '@knowscroll/ui';

interface ChoiceProps {
  readonly label: string;
  /** What choosing it means, in the words of F02 ("Private · not shown to visitors"). */
  readonly description?: string;
  readonly checked: boolean;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly testID?: string;
  readonly children?: ReactNode;
}

function Row({
  role,
  label,
  description,
  checked,
  onPress,
  disabled,
  testID,
  children,
  mark,
}: ChoiceProps & { readonly role: 'radio' | 'switch'; readonly mark: ReactNode }) {
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.block}>
      <Pressable
        {...focus.props}
        testID={testID}
        accessibilityRole={role}
        accessibilityLabel={label}
        accessibilityState={{ checked, disabled: disabled === true }}
        disabled={disabled}
        onPress={onPress}
        style={[styles.row, checked ? styles.checked : null, focus.style]}
      >
        {mark}
        <View style={styles.text}>
          <Text variant="bodyS">{label}</Text>
          {description === undefined ? null : (
            <Text variant="meta" color={content.ink2}>
              {description}
            </Text>
          )}
        </View>
      </Pressable>
      {children}
    </View>
  );
}

/** One option of a single choice (F02 `label.radio`): a 48 px row, announced as a radio button. */
export function RadioRow(props: ChoiceProps) {
  return (
    <Row
      {...props}
      role="radio"
      mark={
        <View style={[styles.radio, props.checked ? styles.radioOn : null]} aria-hidden>
          {props.checked ? <View style={styles.radioDot} /> : null}
        </View>
      }
    />
  );
}

/** A two-state row (F02 `button.sw[role=switch]`): the system's name, and whether visitors see it. */
export function SwitchRow(props: ChoiceProps) {
  return (
    <Row
      {...props}
      role="switch"
      mark={
        <View style={[styles.switch, props.checked ? styles.switchOn : null]} aria-hidden>
          {props.checked ? <Icon name="check" size={14} color={content.onAccent} strokeWidth={3} /> : null}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.comfortable,
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  checked: { backgroundColor: content.paper2 },
  text: { flex: 1, gap: 2 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.paper,
  },
  radioOn: { backgroundColor: content.accent },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: content.onAccent },
  switch: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.paper,
  },
  switchOn: { backgroundColor: content.accent },
});
