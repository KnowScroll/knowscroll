import * as Clipboard from 'expo-clipboard';
import { useState, type ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import {
  capsuleLabel,
  clockTime,
  heldReactions,
  messagePreview,
  quoteView,
  type QuotableMessage,
} from '@knowscroll/client-core';
import type { MessageReactionKind } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import {
  Icon,
  IconButton,
  MenuList,
  MenuRow,
  QuoteStrip,
  ReactionBar,
  ReactionPill,
  Text,
  TalkBubble,
  TalkMenu,
  useDisplay,
  useTalkTheme,
} from '@knowscroll/ui';
import { ReactorSheet } from './reactor-sheet';
import { useSwipeToReply } from './use-swipe-reply';

/** One message that is not removed: what the quote, the reactions and the menu are built from. */
export type AvailableTalkMessage = Extract<QuotableMessage, { status: 'available' }>;

/** What a message says. A card (a shared Reel or Scroll, a snippet) brings its own drawing. */
export type TalkMessageBody =
  { readonly kind: 'text'; readonly text: string } | { readonly kind: 'card'; readonly node: ReactNode };

export interface TalkMessageProps {
  readonly message: AvailableTalkMessage;
  /** Every message the reader holds, so a quote reads the original as it is now. */
  readonly all: readonly QuotableMessage[];
  readonly mine: boolean;
  /** The last message of a run carries the bubble's tail. */
  readonly tail: boolean;
  /** The reader's public person ID, for "You" in the list of who reacted. */
  readonly ownPersonId: string | undefined;
  readonly flash: 'fill' | 'outline' | undefined;
  /** False once the conversation has ended: it can still be read, nothing more can be said or reacted. */
  readonly open: boolean;
  readonly body: TalkMessageBody;
  readonly onReply: (message: AvailableTalkMessage) => void;
  readonly onReact: (message: AvailableTalkMessage, kind: MessageReactionKind, present: boolean) => void;
  /** Reports another person's message; absent for your own. */
  readonly onReport?: ((message: AvailableTalkMessage) => void) | undefined;
  readonly onJump: (sequence: number) => void;
  /** Rows a screen adds to the menu after Copy (a thread's What if…). */
  readonly extraRows?: ((close: () => void) => ReactNode) | undefined;
}

/** The words a person copies from a message: its text, or the note of a card. */
const copyTextOf = (message: AvailableTalkMessage): string => {
  const words = message.body.kind === 'text' ? message.body.text : (message.body.note ?? '');
  return words.trim();
};

/** A right-click on the web opens the same menu as a long press; elsewhere there is no such click. */
function contextMenuProps(open: () => void): object {
  if (Platform.OS !== 'web') return {};
  return {
    onContextMenu: (event: { preventDefault?: () => void }) => {
      event.preventDefault?.();
      open();
    },
  };
}

/**
 * One message in Talk (T3 kit): the bubble with its quote and reactions, and every way to act on it. A
 * swipe right (touch only), the R key and the Reply row ask to reply; a long press, a right-click, the ⋯ button, the E
 * key and a screen reader's custom actions open the menu with the five reactions, Reply, Copy and Report.
 * The quote button jumps to the original. Reacting and replying never record anything about what the
 * reader has seen.
 */
export function TalkMessage(props: TalkMessageProps) {
  const { message, all, mine, tail, ownPersonId, flash, open, body, onReply, onReact, onReport, onJump } = props;
  const theme = useTalkTheme();
  const { reducedMotion } = useDisplay();
  const [menu, setMenu] = useState(false);
  const [who, setWho] = useState<MessageReactionKind | undefined>(undefined);
  const [optionsShown, setOptionsShown] = useState(false);
  const swipe = useSwipeToReply({ enabled: open, reducedMotion, onReply: () => onReply(message) });
  const quote = message.replyTo === undefined ? undefined : quoteView(message.replyTo, all, ownPersonId);
  const held = heldReactions(message);
  const reactions = message.reactions ?? [];
  const copyText = copyTextOf(message);
  const isText = body.kind === 'text';
  const name = mine ? 'You' : message.author.displayName;
  const at = new Date(message.recordedAt);
  const spoken = `${name}, ${capsuleLabel(at, new Date())} ${clockTime(at)}`;
  const showOptions = Platform.OS === 'web' || !isText;

  const close = () => setMenu(false);
  const jump = quote === undefined || quote.author === undefined ? undefined : () => onJump(quote.sequence);
  const reply = () => {
    close();
    onReply(message);
  };
  const actions = [
    ...(open ? [{ name: 'reply', label: 'Reply' }] : []),
    ...(open ? [{ name: 'react', label: 'React' }] : []),
    ...(copyText === '' ? [] : [{ name: 'copy', label: 'Copy' }]),
    ...(onReport === undefined ? [] : [{ name: 'report', label: 'Report this message' }]),
    ...(jump === undefined ? [] : [{ name: 'original', label: 'Go to the original message' }]),
  ];
  const act = (action: string) => {
    if (action === 'reply') reply();
    else if (action === 'react') setMenu(true);
    else if (action === 'copy') void Clipboard.setStringAsync(copyText);
    else if (action === 'report') onReport?.(message);
    else if (action === 'original') jump?.();
  };
  const onKeyDown = (event: unknown) => {
    const key = event as {
      key?: string;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      preventDefault?: () => void;
    };
    if (key.altKey === true || key.ctrlKey === true || key.metaKey === true) return;
    const letter = key.key?.toLowerCase();
    if (letter === 'r' && open) {
      key.preventDefault?.();
      reply();
    } else if (letter === 'e' || key.key === 'ContextMenu' || (key.shiftKey === true && key.key === 'F10')) {
      key.preventDefault?.();
      setMenu(true);
    }
  };

  const quoted =
    quote === undefined ? null : (
      <QuoteStrip
        onOwnBubble={mine}
        author={quote.author}
        preview={quote.preview}
        onJump={jump}
        onLongPress={() => setMenu(true)}
      />
    );
  const content =
    body.kind === 'text' ? (
      <View
        accessible={Platform.OS !== 'web'}
        accessibilityLabel={`${spoken}: ${body.text}`}
        accessibilityActions={actions}
        onAccessibilityAction={(event) => act(event.nativeEvent.actionName)}
      >
        <TalkBubble mine={mine} tail={tail} flash={flash} testID={`bubble-${String(message.sequence)}`}>
          {quoted}
          <Text variant="bubble" color={mine ? theme.bubbleOwn.text : theme.bubbleOther.text} selectable>
            {body.text}
          </Text>
        </TalkBubble>
      </View>
    ) : (
      <View style={styles.card}>
        {quoted === null ? null : (
          <TalkBubble mine={mine} tail={false}>
            {quoted}
          </TalkBubble>
        )}
        {body.node}
      </View>
    );

  const options = showOptions ? (
    <View style={{ opacity: optionsShown ? 1 : 0 }}>
      <IconButton
        icon="more"
        label={`Options for ${mine ? 'your' : `${message.author.displayName}’s`} message`}
        accessibilityHint={open ? 'Reply with R, react with E' : 'React with E'}
        variant="plain"
        size={44}
        color={theme.textQuiet}
        onPress={() => setMenu(true)}
        onFocus={() => setOptionsShown(true)}
        onBlur={() => setOptionsShown(false)}
        testID={`message-options-${String(message.sequence)}`}
      />
    </View>
  ) : null;

  return (
    <View
      testID={`message-${String(message.sequence)}`}
      style={[styles.row, mine ? styles.end : styles.start]}
      {...swipe.handlers}
      onKeyDown={onKeyDown}
    >
      <Animated.View pointerEvents="none" style={[styles.arrow, { opacity: swipe.arrow }]}>
        <Icon name="reply" size={22} color={theme.textQuiet} />
      </Animated.View>
      <Animated.View style={[styles.slide, mine ? styles.end : styles.start, swipe.slide]}>
        <View style={[styles.line, mine ? styles.end : styles.start]}>
          {mine ? options : null}
          <Pressable
            accessible={false}
            focusable={false}
            onLongPress={() => setMenu(true)}
            delayLongPress={400}
            {...contextMenuProps(() => setMenu(true))}
            onHoverIn={() => setOptionsShown(true)}
            onHoverOut={() => setOptionsShown(false)}
            style={[styles.body, mine ? styles.alignEnd : styles.alignStart]}
          >
            {content}
            {reactions.length === 0 ? null : (
              <View style={styles.pills} testID={`reactions-${String(message.sequence)}`}>
                {reactions.map((reaction) => (
                  <ReactionPill
                    key={reaction.kind}
                    kind={reaction.kind}
                    count={reaction.people.length}
                    mine={reaction.mine}
                    onPress={() => setWho(reaction.kind)}
                  />
                ))}
              </View>
            )}
          </Pressable>
          {mine ? null : options}
        </View>
      </Animated.View>
      <TalkMenu
        visible={menu}
        title="Message options"
        onClose={close}
        echoAlign={mine ? 'end' : 'start'}
        echo={
          <TalkBubble mine={mine} tail>
            <Text variant="bubble" color={mine ? theme.bubbleOwn.text : theme.bubbleOther.text} numberOfLines={6}>
              {isText ? body.text : messagePreview(message) || 'A shared Reel or Scroll'}
            </Text>
          </TalkBubble>
        }
      >
        {open ? (
          <ReactionBar
            held={held}
            onPick={(kind) => {
              close();
              onReact(message, kind, !held.has(kind));
            }}
          />
        ) : null}
        <MenuList>
          {open ? <MenuRow icon="reply" label="Reply" keyHint="R" onPress={reply} testID="menu-reply" /> : null}
          {copyText === '' ? null : (
            <MenuRow
              icon="copy"
              label="Copy"
              onPress={() => {
                close();
                void Clipboard.setStringAsync(copyText);
              }}
              testID="menu-copy"
            />
          )}
          {props.extraRows?.(close)}
          {onReport === undefined ? null : (
            <MenuRow
              icon="flag"
              label="Report"
              danger
              onPress={() => {
                close();
                onReport(message);
              }}
              testID="menu-report"
            />
          )}
        </MenuList>
      </TalkMenu>
      <ReactorSheet
        kind={who}
        people={reactions.find((reaction) => reaction.kind === who)?.people ?? []}
        ownPersonId={ownPersonId}
        mine={who !== undefined && held.has(who)}
        onToggle={() => who !== undefined && onReact(message, who, !held.has(who))}
        onClose={() => setWho(undefined)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: '100%', justifyContent: 'center' },
  slide: { width: '100%' },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], maxWidth: '100%' },
  body: { gap: spacing[1], flexShrink: 1, maxWidth: '100%' },
  card: { gap: spacing[1], maxWidth: '100%' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1], marginHorizontal: spacing[2] },
  arrow: { position: 'absolute', left: spacing[2], top: '35%' },
  start: { alignSelf: 'flex-start', justifyContent: 'flex-start' },
  end: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
  alignStart: { alignItems: 'flex-start' },
  alignEnd: { alignItems: 'flex-end' },
});
