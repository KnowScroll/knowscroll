import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { formatWithUnit, type SimulationParam } from '../../model';
import { IconButton } from '../../../actions/icon-button';
import { useFocusRing } from '../../../display/focus-ring';
import { Text } from '../../../text/text';
import { parseTyped, stepped } from './slider-model';

export interface ValueControlProps {
  readonly param: SimulationParam;
  readonly value: number;
  readonly onChange: (value: number) => void;
}

/**
 * Minus, the value in words, plus: the stepper twin of a slider (E03-4 "Text version", where
 * every number gets one) and a primary control of its own. The value is a polite live region, so
 * a change is announced; the buttons are 48 px and are disabled at the ends of the range.
 */
export function Stepper({ param, value, onChange }: ValueControlProps) {
  const text = formatWithUnit(value, param.format, param.unit);
  return (
    <View style={styles.stepper}>
      <IconButton
        icon="minus"
        label={`Less ${param.label}`}
        disabled={value <= param.min}
        onPress={() => onChange(stepped(param, value, -1))}
      />
      <View accessibilityLiveRegion="polite" role="status" style={styles.value}>
        <Text variant="heading" align="center">
          {text}
        </Text>
      </View>
      <IconButton
        icon="plus"
        label={`More ${param.label}`}
        disabled={value >= param.max}
        onPress={() => onChange(stepped(param, value, 1))}
      />
    </View>
  );
}

/**
 * A typed number (E09-4): a labelled field with a numeric keyboard and the stepper buttons beside
 * it. What is typed is read as a reader writes a number ("60 kg", "4,096"), snapped onto the
 * parameter's grid and kept on blur or submit; text that is not a number is put back.
 */
export function NumberInput({ param, value, onChange }: ValueControlProps) {
  const shown = formatWithUnit(value, param.format, param.unit);
  const [draft, setDraft] = useState<string | null>(null);
  const focus = useFocusRing('onLight');
  const commit = () => {
    if (draft === null) return;
    const parsed = parseTyped(draft);
    setDraft(null);
    if (parsed !== null) onChange(stepped(param, Math.min(param.max, Math.max(param.min, parsed)), 0));
  };
  return (
    <View style={styles.input}>
      <IconButton
        icon="minus"
        label={`Less ${param.label}`}
        disabled={value <= param.min}
        onPress={() => onChange(stepped(param, value, -1))}
      />
      <View style={[styles.fieldWrap, focus.style]}>
        <TextInput
          {...focus.props}
          accessibilityLabel={param.label}
          value={draft ?? shown}
          onChangeText={setDraft}
          onFocus={() => {
            focus.props.onFocus();
            setDraft(shown);
          }}
          onBlur={() => {
            focus.props.onBlur();
            commit();
          }}
          onSubmitEditing={commit}
          inputMode="decimal"
          keyboardType="decimal-pad"
          selectTextOnFocus
          style={styles.field}
        />
      </View>
      <IconButton
        icon="plus"
        label={`More ${param.label}`}
        disabled={value >= param.max}
        onPress={() => onChange(stepped(param, value, 1))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] },
  value: { flex: 1 },
  input: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  fieldWrap: { flex: 1, minWidth: 0, borderRadius: radius.md },
  field: {
    minHeight: target.comfortable,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
    color: content.ink,
    textAlign: 'center',
    fontWeight: '700',
    fontSize: 17,
  },
});
