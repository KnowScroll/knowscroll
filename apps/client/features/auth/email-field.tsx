import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, space, spacing, status, target } from '@knowscroll/design-tokens';
import { Text, useTypeStyle } from '@knowscroll/ui';

/**
 * The labelled email field of the sign-in form (A01, undrawn in the export: built from the
 * tokens; the coordinator aligns it with `packages/ui` inputs when they exist). The visible label
 * names the field; an error is announced and tied to it; the platform's email keyboard, autofill
 * and no auto-capitalisation or correction.
 */
export function EmailField({
  value,
  onChangeText,
  onSubmit,
  error,
  disabled = false,
}: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit: () => void;
  readonly error?: string;
  readonly disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const type = useTypeStyle('body');
  return (
    <View style={styles.field}>
      <Text variant="uiS" color={space.label} nativeID="email-label">
        Email address
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        editable={!disabled}
        aria-labelledby="email-label"
        accessibilityLabel="Email address"
        testID="email-field"
        {...(error === undefined ? {} : { 'aria-describedby': 'email-error', 'aria-invalid': true })}
        autoComplete="email"
        textContentType="emailAddress"
        inputMode="email"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="send"
        enterKeyHint="send"
        placeholder="you@example.com"
        placeholderTextColor={content.muted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            fontFamily: type.fontFamily,
            fontWeight: type.fontWeight,
            fontSize: type.fontSize,
            borderColor: error === undefined ? (focused ? space.focus : content.ink) : status.danger.edge,
          },
        ]}
      />
      {error === undefined ? null : (
        <View role="alert">
          <Text variant="bodyS" color={space.star} nativeID="email-error">
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { alignSelf: 'stretch', gap: spacing[2] },
  input: {
    minHeight: target.comfortable,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.regular,
    backgroundColor: content.paper,
    color: content.ink,
  },
});
