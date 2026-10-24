import { useEffect, useRef, type RefObject } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { dayKey, dayLabel, type ThreadController, type ThreadState } from '@knowscroll/client-core';
import type { ConversationMessage } from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AwayDivider, firstAwayMessage, MessageBubble, OutgoingBubble } from './message-views';

/** How close to the end still counts as "reading the latest" (px). */
const NEAR_END = 80;

/** Messages grouped under a day label; a tombstone has no time and stays in the day before it. */
function dividedByDay(messages: readonly ConversationMessage[]) {
  const groups: { key: string; at: Date; items: ConversationMessage[] }[] = [];
  for (const message of messages) {
    const at = message.status === 'available' ? new Date(message.recordedAt) : undefined;
    const last = groups.at(-1);
    if (at === undefined && last !== undefined) last.items.push(message);
    else if (last !== undefined && at !== undefined && last.key === dayKey(at)) last.items.push(message);
    else if (at !== undefined) groups.push({ key: dayKey(at), at, items: [message] });
    else groups.push({ key: 'removed', at: new Date(), items: [message] });
  }
  return groups;
}

/**
 * Keeps the newest message in view for a reader who is already at the end, and leaves a reader
 * who scrolled up where they are. `changeKey` changes whenever the list grows or first appears.
 */
export function useFollowEnd(changeKey: string) {
  const ref = useRef<ScrollViewInstance>(null);
  const nearEnd = useRef(true);
  useEffect(() => {
    if (nearEnd.current) ref.current?.scrollToEnd({ animated: false });
  }, [changeKey]);
  return {
    ref,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      nearEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - NEAR_END;
    },
    /** The person just sent something: follow it to the end. */
    follow: () => {
      nearEnd.current = true;
    },
  };
}

export interface MessageListProps {
  readonly state: ThreadState;
  readonly controller: ThreadController;
  readonly name: string;
  /** From `useFollowEnd`: the scroll view's ref and scroll handler. */
  readonly scrollRef: RefObject<ScrollViewInstance | null>;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/** The messages by day, then the ones still being sent. "Sent" marks the person's latest message once nothing is pending. */
export function MessageList({ state, controller, name, scrollRef, onScroll }: MessageListProps) {
  const mineOf = (message: ConversationMessage) =>
    message.status === 'available' && message.author.personId !== state.peer?.personId;
  const lastMineSequence = [...state.messages].reverse().find(mineOf)?.sequence;
  const now = new Date();
  const awayFrom = firstAwayMessage(state.messages, state.awayAfterSequence);
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      onScroll={onScroll}
      scrollEventThrottle={100}
      testID="conversation-messages"
    >
      {state.hasOlder ? (
        <Button
          label="Earlier messages"
          size="sm"
          variant="ghost"
          busy={state.loadingOlder}
          busyLabel="Loading"
          onPress={() => void controller.loadOlder()}
        />
      ) : null}
      {state.messages.length === 0 && state.outgoing.length === 0 ? (
        <Text variant="meta" color={content.ink2} align="center">
          No messages yet. Say hello.
        </Text>
      ) : null}
      <View role="list" accessibilityLabel={`Messages with ${name}`} style={styles.messages}>
        {dividedByDay(state.messages).map((group) => (
          <View key={group.key + String(group.items[0]?.sequence)} style={styles.messages}>
            <Text variant="metaS" color={content.ink2} align="center">
              {dayLabel(group.at, now)}
            </Text>
            {group.items.map((message) => (
              <View key={message.sequence} role="listitem" style={styles.item}>
                {message.sequence === awayFrom ? <AwayDivider /> : null}
                <MessageBubble message={message} mine={mineOf(message)} />
                {message.sequence === lastMineSequence && state.outgoing.length === 0 ? (
                  <Text variant="monoXs" color={content.ink2} align="right">
                    Sent
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ))}
        {state.outgoing.map((entry) => (
          <View key={entry.commandId} role="listitem">
            <OutgoingBubble
              entry={entry}
              onRetry={() => void controller.retry(entry.commandId)}
              onDismiss={() => controller.dismiss(entry.commandId)}
            />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: content.paper2 },
  /** Messages keep the reading measure, centred, on wide screens (the multi-pane layout is D01 to D05). */
  listContent: {
    padding: layout.gutter,
    gap: spacing[3],
    flexGrow: 1,
    justifyContent: 'flex-end',
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  messages: { gap: spacing[3] },
  item: { gap: spacing[1] },
});
