import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Text, useTypeStyle } from '@knowscroll/ui';

/**
 * One labelled single- or multi-line text field. The label is the accessible name and stays visible;
 * the limit is the server's, so a person cannot type what would be refused.
 */
export function FormField({
  label,
  value,
  onChange,
  maxLength,
  multiline,
  hint,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly maxLength: number;
  readonly multiline?: boolean;
  readonly hint?: string;
  readonly testID?: string;
}) {
  const type = useTypeStyle('bodyS');
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text variant="metaS" color={content.ink2}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        maxLength={maxLength}
        multiline={multiline === true}
        allowFontScaling={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          multiline === true ? styles.multiline : null,
          {
            fontFamily: type.fontFamily,
            fontSize: type.fontSize,
            lineHeight: type.lineHeight,
            borderColor: focused ? content.accent : content.ink,
          },
        ]}
      />
      {hint === undefined ? null : (
        <Text variant="metaS" color={content.ink2}>
          {hint}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing['1'] },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.regular,
    borderRadius: radius.md,
    color: content.ink,
    backgroundColor: content.paper,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
});
