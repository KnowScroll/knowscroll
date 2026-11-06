import { useEffect, useId, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { layout, spacing } from '@knowscroll/design-tokens';
import { Icon, ReplyChip, Text, useFocusRing, useTalkTheme, useTypeStyle } from '@knowscroll/ui';
import { insertMention, mentionedOption, mentionQuery, type MentionOption } from './mention-input';
import { MentionPicker } from './mention-picker';

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
  focusSignal,
  mentions,
}: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly replyTo?: ReplyTarget | undefined;
  readonly onCancelReply?: (() => void) | undefined;
  /** Each new value puts the cursor in the box (a button elsewhere that says "answer here"). */
  readonly focusSignal?: number | undefined;
  /** Only rooms supply this roster. Other conversation composers retain their existing behavior. */
  readonly mentions?: readonly MentionOption[];
}) {
  const theme = useTalkTheme();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    if (focusSignal !== undefined && focusSignal > 0) input.current?.focus();
  }, [focusSignal]);
  const type = useTypeStyle('bodyS');
  const sendFocus = useFocusRing('onDark');
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  const menuId = useId();
  const query = mentions === undefined ? undefined : mentionQuery(value, caret);
  const queryKey = `${value}:${caret}`;
  const matches =
    mentions?.filter(
      (option) => query !== undefined && option.name.toLowerCase().startsWith(query.query.toLowerCase()),
    ) ?? [];
  const open = focused && query !== undefined && dismissed !== queryKey;
  const selected = mentions === undefined ? undefined : mentionedOption(value, mentions);
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const pick = (option: MentionOption) => {
    if (query === undefined || option.disabled === true) return;
    const next = insertMention(value, query, option.name);
    if (next.text.length > MAX_LENGTH) return;
    onChange(next.text);
    setCaret(next.caret);
    setSelection({ start: next.caret, end: next.caret });
    setDismissed(undefined);
    input.current?.focus();
  };
  const text = value.trim();
  const send = () => {
    if (text !== '') onSend(text);
  };
  return (
    <View style={[styles.bar, { backgroundColor: theme.bar.fill, borderTopColor: theme.bar.edge }]}>
      <View style={styles.column}>
        {open ? <MentionPicker id={menuId} options={matches} active={activeIndex} onPick={pick} /> : null}
        {selected === undefined ? null : (
          <View accessibilityLiveRegion="polite">
            <Text
              variant="metaS"
              color={theme.bar.text}
            >{`To ${selected.name} · ${selected.label}${selected.status === undefined ? '' : ` · ${selected.status}`}`}</Text>
          </View>
        )}
        {replyTo === undefined || onCancelReply === undefined ? null : (
          <ReplyChip author={replyTo.author} preview={replyTo.preview} onCancel={onCancelReply} />
        )}
        <View style={styles.row}>
          <TextInput
            ref={input}
            accessibilityLabel={`Message ${name}`}
            placeholder={`Message ${name}`}
            placeholderTextColor={theme.input.placeholder}
            value={value}
            onChangeText={(next) => {
              setCaret(Math.max(0, Math.min(next.length, caret + next.length - value.length)));
              setSelection(undefined);
              setActive(0);
              onChange(next);
            }}
            selection={selection}
            onSelectionChange={(event) => {
              const next = event.nativeEvent.selection;
              setCaret(next.end);
              setSelection(undefined);
              if (next.start !== next.end) setDismissed(`${value}:${next.end}`);
            }}
            aria-haspopup={mentions === undefined ? undefined : 'menu'}
            aria-autocomplete={mentions === undefined ? undefined : 'list'}
            aria-controls={open ? menuId : undefined}
            aria-activedescendant={
              open && matches[activeIndex] !== undefined ? `${menuId}-${matches[activeIndex].id}` : undefined
            }
            multiline
            maxLength={MAX_LENGTH}
            allowFontScaling={false}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyPress={(event) => {
              const key = event.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean };
              if (Platform.OS !== 'web') return;
              if (key.isComposing === true) return;
              if (open && key.key === 'Enter' && key.shiftKey === true) {
                setDismissed(queryKey);
                return;
              }
              if (
                open &&
                key.key === 'Tab' &&
                (key.shiftKey === true || matches[activeIndex] === undefined || matches[activeIndex]?.disabled === true)
              ) {
                setDismissed(queryKey);
                return;
              }
              if (open && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(key.key)) {
                (event as unknown as { preventDefault?: () => void }).preventDefault?.();
                if (key.key === 'Escape') setDismissed(queryKey);
                else if (key.key === 'ArrowDown') setActive((activeIndex + 1) % Math.max(matches.length, 1));
                else if (key.key === 'ArrowUp')
                  setActive((activeIndex + matches.length - 1) % Math.max(matches.length, 1));
                else if (matches[activeIndex] !== undefined) pick(matches[activeIndex]);
              } else if (key.key === 'Escape' && onCancelReply !== undefined && replyTo !== undefined) {
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
