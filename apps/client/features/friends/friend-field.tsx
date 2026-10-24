import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Text, useTypeStyle } from '@knowscroll/ui';

/** A labelled text field of the Friends screens: no autofill, no autocorrect, focus drawn in cobalt. */
export function FriendField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  secret = false,
  disabled = false,
  onSubmit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly disabled?: boolean;
  readonly onSubmit?: () => void;
}) {
  const type = useTypeStyle('bodyS');
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text variant="uiS">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        maxLength={maxLength}
        editable={!disabled}
        secureTextEntry={secret}
        placeholder={placeholder}
        placeholderTextColor={content.ink2}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        allowFontScaling={false}
        style={[
          styles.input,
          {
            fontFamily: type.fontFamily,
            fontSize: type.fontSize,
            lineHeight: type.lineHeight,
            borderColor: focused ? content.accent : content.ink,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing[2] },
  input: {
    color: content.ink,
    backgroundColor: content.paper2,
    minHeight: target.comfortable,
    borderWidth: borderWidth.regular,
    borderRadius: radius.md,
    paddingHorizontal: spacing['3.5'],
    paddingVertical: spacing[3],
  },
});
