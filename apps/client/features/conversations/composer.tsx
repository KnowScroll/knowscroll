import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { IconButton, useTypeStyle } from '@knowscroll/ui';

const MAX_LENGTH = 2000;

/**
 * The message box and Send. Enter sends on the web (Shift+Enter is a new line); on a phone the Send
 * button does. A blank message is never sent; the text clears only after Send is pressed, and a
 * failed send stays a bubble in the thread, not text to retype.
 */
export function Composer({
  name,
  value,
  onChange,
  onSend,
}: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onSend: (text: string) => void;
}) {
  const type = useTypeStyle('bodyS');
  const [focused, setFocused] = useState(false);
  const text = value.trim();
  const send = () => {
    if (text !== '') onSend(text);
  };
  return (
    <View style={styles.bar}>
      <TextInput
        accessibilityLabel={`Message ${name}`}
        placeholder={`Message ${name}`}
        placeholderTextColor={content.ink2}
        value={value}
        onChangeText={onChange}
        multiline
        maxLength={MAX_LENGTH}
        allowFontScaling={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyPress={(event) => {
          const key = event.nativeEvent as unknown as { key: string; shiftKey?: boolean };
          if (Platform.OS === 'web' && key.key === 'Enter' && key.shiftKey !== true) {
            (event as unknown as { preventDefault?: () => void }).preventDefault?.();
            send();
          }
        }}
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
      <IconButton icon="send" label="Send message" variant="accent" disabled={text === ''} onPress={send} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing[2],
    padding: spacing[3],
    borderTopWidth: borderWidth.regular,
    borderTopColor: content.ink,
    backgroundColor: content.paper,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 140,
    borderWidth: borderWidth.regular,
    borderRadius: radius.panel,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    backgroundColor: content.paper,
    color: content.ink,
  },
});
