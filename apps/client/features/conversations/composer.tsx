import { useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { layout, spacing } from '@knowscroll/design-tokens';
import { Icon, ReplyChip, useFocusRing, useTalkTheme, useTypeStyle } from '@knowscroll/ui';

const MAX_LENGTH = 2000;
const SEND_SIZE = 44;

/** The message a reply answers, while its chip waits above the box. */
export interface ReplyTarget {
  readonly author: string;
  readonly preview: string;
}

/**
 * The message box and Send, in the Talk look (T3 kit): a glass bar with a paper field and a cobalt Send
 * that fades to 40 % while empty, never to a pale tint. Enter sends on the web (Shift+Enter is a new line);
 * on a phone the Send button does. A reply waits as a chip above the field, named for who it answers; its
 * ✕, Esc or sending clears it. A blank message is never sent; the text clears only after Send is pressed,
 * and a failed send stays a bubble in the thread, not text to retype.
 */
export function Composer({
  name,
  value,
  onChange,
  onSend,
  replyTo,
  onCancelReply,
}: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly replyTo?: ReplyTarget | undefined;
  readonly onCancelReply?: (() => void) | undefined;
}) {
  const theme = useTalkTheme();
  const type = useTypeStyle('bodyS');
  const sendFocus = useFocusRing('onDark');
  const [focused, setFocused] = useState(false);
  const text = value.trim();
  const send = () => {
    if (text !== '') onSend(text);
  };
  return (
    <View style={[styles.bar, { backgroundColor: theme.bar.fill, borderTopColor: theme.bar.edge }]}>
      <View style={styles.column}>
        {replyTo === undefined || onCancelReply === undefined ? null : (
          <ReplyChip author={replyTo.author} preview={replyTo.preview} onCancel={onCancelReply} />
        )}
        <View style={styles.row}>
          <TextInput
            accessibilityLabel={`Message ${name}`}
            placeholder={`Message ${name}`}
            placeholderTextColor={theme.input.placeholder}
            value={value}
            onChangeText={onChange}
            multiline
            maxLength={MAX_LENGTH}
            allowFontScaling={false}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyPress={(event) => {
              const key = event.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (Platform.OS !== 'web') return;
              if (key.key === 'Escape' && onCancelReply !== undefined && replyTo !== undefined) {
                (event as unknown as { preventDefault?: () => void }).preventDefault?.();
                onCancelReply();
              } else if (key.key === 'Enter' && key.shiftKey !== true) {
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
                backgroundColor: theme.input.fill,
                color: theme.input.text,
                borderColor: focused ? theme.focus : theme.input.edge,
              },
            ]}
          />
          <Pressable
            {...sendFocus.props}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            aria-disabled={text === ''}
            disabled={text === ''}
            onPress={send}
            testID="send-message"
            style={[
              styles.send,
              { backgroundColor: theme.send.fill, boxShadow: theme.send.shadow },
              text === '' ? styles.sendEmpty : null,
              sendFocus.style,
            ]}
          >
            <Icon name="send" size={22} color={theme.send.glyph} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { padding: spacing[3], borderTopWidth: 1 },
  /** On wide screens the box keeps the reading measure, centred under the messages. */
  column: { gap: spacing[2], width: '100%', maxWidth: layout.measureDesktop, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[2] },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 140,
    borderWidth: 2,
    borderRadius: 24,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  send: {
    width: SEND_SIZE,
    height: SEND_SIZE,
    marginBottom: spacing[1],
    borderRadius: SEND_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** T3 kit: disabled is 40 %, never a pale tint. */
  sendEmpty: { opacity: 0.4 },
});
