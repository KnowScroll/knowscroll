import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, status, target } from '@knowscroll/design-tokens';
import { Text, useFocusRing } from '@knowscroll/ui';

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
  // A radio is a boxed card with its mark first; a switch is a plain list row with its mark last (F02).
  const flat = role === 'switch';
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.block}>
      <Pressable
        {...focus.props}
        testID={testID}
        role={role}
        accessibilityLabel={label}
        aria-checked={checked}
        aria-disabled={disabled === true}
        disabled={disabled}
        onPress={onPress}
        style={[styles.row, flat ? styles.flat : checked ? styles.checked : null, focus.style]}
      >
        {flat ? null : mark}
        <View style={styles.text}>
          <Text variant="bodyS">{label}</Text>
          {description === undefined ? null : (
            <Text variant="meta" color={content.ink2}>
              {description}
            </Text>
          )}
        </View>
        {flat ? mark : null}
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
          <View style={[styles.knob, props.checked ? styles.knobOn : null]} />
        </View>
      }
    />
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * A short single choice drawn as one pill with the chosen option filled (F02 "Activity status").
 * Each option is a radio; the group is named by `label`.
 */
export function SegmentedChoice<T extends string>({
  label,
  options,
  value,
  disabled,
  testIDPrefix,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly disabled?: boolean;
  readonly testIDPrefix: string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View role="radiogroup" accessibilityLabel={label} style={styles.segments}>
      {options.map((option) => (
        <Segment
          key={option.value}
          label={option.label}
          checked={option.value === value}
          disabled={disabled === true}
          testID={`${testIDPrefix}-${option.value}`}
          onPress={() => onChange(option.value)}
        />
      ))}
    </View>
  );
}

function Segment({
  label,
  checked,
  disabled,
  testID,
  onPress,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly testID: string;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      testID={testID}
      role="radio"
      accessibilityLabel={label}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.segment, checked ? styles.segmentOn : null, focus.style]}
    >
      <Text variant="uiS" color={checked ? content.paper : content.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segments: {
    flexDirection: 'row',
    padding: 3,
    gap: 2,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
    borderRadius: radius.pill,
  },
  segmentOn: { backgroundColor: content.ink },
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
  /** The pale cobalt of the chosen row, edged in cobalt (F02). */
  checked: { backgroundColor: status.hypothetical.background, borderColor: content.accent },
  flat: {
    borderWidth: 0,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
    borderRadius: 0,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
  },
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
    width: 52,
    height: 32,
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    justifyContent: 'center',
    paddingHorizontal: 3,
    backgroundColor: content.paper2,
  },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: content.ink },
  knobOn: { alignSelf: 'flex-end', backgroundColor: content.onAccent },
  switchOn: { backgroundColor: content.accent },
});
