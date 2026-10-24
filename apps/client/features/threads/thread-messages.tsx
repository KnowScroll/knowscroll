import { type RefObject } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import {
  dayKey,
  dayLabel,
  type ContentThreadController,
  type ContentThreadState,
  type OutgoingThreadMessage,
} from '@knowscroll/client-core';
import type { ThreadEpisode, ThreadMessage } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { SnippetCard } from './snippet-card';

interface Group {
  readonly key: string;
  readonly at: Date;
  readonly items: ThreadMessage[];
}

/** Messages grouped under a day label; a tombstone has no time and stays in the day before it. */
function dividedByDay(messages: readonly ThreadMessage[]): Group[] {
  const groups: { key: string; at: Date; items: ThreadMessage[] }[] = [];
  for (const message of messages) {
    const at = message.status === 'available' ? new Date(message.recordedAt) : undefined;
    const last = groups.at(-1);
    if (at === undefined && last !== undefined) last.items.push(message);
    else if (last !== undefined && at !== undefined && last.key === dayKey(at)) last.items.push(message);
    else groups.push({ key: at === undefined ? 'removed' : dayKey(at), at: at ?? new Date(), items: [message] });
  }
  return groups;
}

function Bubble({
  message,
  mine,
  partOf,
  onOpenSnippet,
}: {
  readonly message: ThreadMessage;
  readonly mine: boolean;
  readonly partOf: (assetId: string) => string | undefined;
  readonly onOpenSnippet: (messageId: string) => void;
}) {
  if (message.status === 'unavailable')
    return (
      <View style={[styles.bubble, styles.removed, mine ? styles.mine : styles.theirs]}>
        <Text variant="meta" color={content.ink2}>
          Message removed
        </Text>
      </View>
    );
  const align = mine ? styles.mine : styles.theirs;
  if (message.body.kind === 'snippet') {
    const { snippet, note } = message.body;
    const target = snippet.content.target;
    return (
      <View style={[styles.snippet, align]}>
        {note === undefined ? null : (
          <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble]}>
            <Text variant="bodyS" color={mine ? content.onAccent : content.ink} selectable>
              {note}
            </Text>
          </View>
        )}
        <SnippetCard
          snippet={snippet}
          partLabel={partOf(target.assetId)}
          onOpen={() => onOpenSnippet(message.messageId)}
        />
      </View>
    );
  }
  return (
    <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble, align]}>
      <Text variant="bodyS" color={mine ? content.onAccent : content.ink} selectable>
        {message.body.text}
      </Text>
    </View>
  );
}

function OutgoingBubble({
  entry,
  onRetry,
  onDismiss,
}: {
  readonly entry: OutgoingThreadMessage;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const failed = entry.status === 'unconfirmed' || entry.status === 'not_sent';
  const words =
    entry.body.kind === 'text'
      ? entry.body.text
      : entry.body.anchor.kind === 'reel_range'
        ? 'Sharing a moment…'
        : entry.body.anchor.kind === 'scroll_passage'
          ? 'Sharing a passage…'
          : 'Sharing a part of a Scroll…';
  return (
    <View style={styles.mine} testID="outgoing-message">
      <View style={[styles.bubble, failed ? styles.failedBubble : styles.mineBubble]}>
        <Text variant="bodyS" color={failed ? content.ink : content.onAccent} selectable>
          {words}
        </Text>
      </View>
      {failed ? (
        <View style={styles.failure} accessibilityLiveRegion="polite">
          <Text variant="metaS" color={status.danger.foreground}>
            {entry.status === 'unconfirmed' ? 'Not confirmed' : 'Not sent'}
          </Text>
          <Button label="Retry" size="sm" icon="retry" onPress={onRetry} />
          {entry.status === 'not_sent' ? (
            <Button label="Dismiss" size="sm" variant="ghost" onPress={onDismiss} />
          ) : null}
        </View>
      ) : (
        <Text variant="monoXs" color={content.ink2}>
          {entry.status === 'sending' ? 'Sending…' : 'Sent'}
        </Text>
      )}
    </View>
  );
}

export interface ThreadMessagesProps {
  readonly state: ContentThreadState;
  readonly controller: ContentThreadController;
  /** The caller's own public person ID: their messages sit on the right. */
  readonly ownPersonId: string | undefined;
  readonly episodes: readonly ThreadEpisode[];
  readonly scrollRef: RefObject<ScrollViewInstance | null>;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onOpenSnippet: (messageId: string) => void;
}

/** The thread's messages by day with the author named above each other person's bubble, then what is still being sent. */
export function ThreadMessages({
  state,
  controller,
  ownPersonId,
  episodes,
  scrollRef,
  onScroll,
  onOpenSnippet,
}: ThreadMessagesProps) {
  const now = new Date();
  const series = state.sequence === 'series';
  const partOf = (assetId: string) => {
    const part = series ? episodes.find((episode) => episode.assetId === assetId)?.part : undefined;
    return part === undefined ? undefined : `Part ${String(part)}`;
  };
  const mineOf = (message: ThreadMessage) => message.status === 'available' && message.author.personId === ownPersonId;
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      onScroll={onScroll}
      scrollEventThrottle={100}
      testID="thread-messages"
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
          Nothing said yet. Say why you’re sharing it, or let it speak.
        </Text>
      ) : null}
      <View role="list" accessibilityLabel="Messages in this thread" style={styles.messages}>
        {dividedByDay(state.messages).map((group) => (
          <View key={group.key + String(group.items[0]?.sequence)} style={styles.messages}>
            <Text variant="metaS" color={content.ink2} align="center">
              {dayLabel(group.at, now)}
            </Text>
            {group.items.map((message) => (
              <View key={message.sequence} role="listitem" style={styles.item}>
                {message.status === 'available' && !mineOf(message) ? (
                  <Text variant="metaS" color={content.ink2}>
                    {message.author.displayName}
                  </Text>
                ) : null}
                <Bubble message={message} mine={mineOf(message)} partOf={partOf} onOpenSnippet={onOpenSnippet} />
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
  bubble: { maxWidth: '82%', borderRadius: radius.panel, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  snippet: { gap: spacing[2], maxWidth: '100%' },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing[1] },
  theirs: { alignSelf: 'flex-start' },
  mineBubble: { backgroundColor: content.accent },
  theirBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: content.ink },
  failedBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: status.danger.edge },
  removed: { backgroundColor: content.paper2, borderWidth: borderWidth.light, borderColor: content.muted },
  failure: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap', justifyContent: 'flex-end' },
});
