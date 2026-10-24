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
import type { ScenarioCard, ScenarioKind, ThreadEpisode, ThreadMessage } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, IconButton, Text } from '@knowscroll/ui';
import { BranchCard } from '../scenarios/branch-card';
import type { AvailableMessage } from '../scenarios/message-step';
import { SnippetCard } from './snippet-card';

/** One thing in the thread's timeline: a message, or a branch card at the moment it was made. */
type Entry =
  | { readonly kind: 'message'; readonly message: ThreadMessage }
  | { readonly kind: 'branch'; readonly card: ScenarioCard };

interface Group {
  readonly key: string;
  readonly at: Date;
  readonly items: Entry[];
}

/**
 * The messages with the branch cards among them, in the order they happened. A card goes where its
 * time falls; a tombstone has no time and stays after the message before it. A removed branch stays
 * where it was as a quiet note, so the conversation around it still reads in order.
 */
export function timeline(messages: readonly ThreadMessage[], cards: readonly ScenarioCard[]): Entry[] {
  const waiting = [...cards].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const entries: Entry[] = [];
  const placeBefore = (time: string | undefined) => {
    while (waiting[0] !== undefined && (time === undefined || waiting[0].createdAt <= time))
      entries.push({ kind: 'branch', card: waiting.shift()! });
  };
  for (const message of messages) {
    if (message.status === 'available') placeBefore(message.recordedAt);
    entries.push({ kind: 'message', message });
  }
  placeBefore(undefined);
  return entries;
}

const timeOf = (entry: Entry): Date | undefined =>
  entry.kind === 'branch'
    ? new Date(entry.card.createdAt)
    : entry.message.status === 'available'
      ? new Date(entry.message.recordedAt)
      : undefined;

/** Entries grouped under a day label; one with no time (a tombstone) stays in the day before it. */
function dividedByDay(entries: readonly Entry[]): Group[] {
  const groups: { key: string; at: Date; items: Entry[] }[] = [];
  for (const entry of entries) {
    const at = timeOf(entry);
    const last = groups.at(-1);
    if (at === undefined && last !== undefined) last.items.push(entry);
    else if (last !== undefined && at !== undefined && last.key === dayKey(at)) last.items.push(entry);
    else groups.push({ key: at === undefined ? 'removed' : dayKey(at), at: at ?? new Date(), items: [entry] });
  }
  return groups;
}

/** Where a branch began, in words: the whole thread, a shared moment or passage, or someone's message. */
function startedLine(card: ScenarioCard, messages: readonly ThreadMessage[]): string {
  if (card.parentNodeId !== undefined) return 'from another branch';
  if (card.origin === 'root' || card.originMessageId === undefined) return 'from the thread';
  if (card.origin === 'snippet') return 'from a shared moment or passage';
  const message = messages.find((candidate) => candidate.messageId === card.originMessageId);
  return message?.status === 'available' ? `from ${message.author.displayName}’s message` : 'from a message';
}

function Bubble({
  message,
  mine,
  partOf,
  onOpenSnippet,
  onWhatIf,
}: {
  readonly message: ThreadMessage;
  readonly mine: boolean;
  readonly partOf: (assetId: string) => string | undefined;
  readonly onOpenSnippet: (messageId: string) => void;
  /** Starts a What if… from this snippet (X01: the button on a snippet card). */
  readonly onWhatIf: (message: AvailableMessage) => void;
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
        {snippet.content.status === 'unavailable' ? null : (
          <Button label="What if…" size="sm" variant="ghost" icon="hypothetical" onPress={() => onWhatIf(message)} />
        )}
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

const entryKey = (entry: Entry | undefined): string =>
  entry === undefined ? '' : entry.kind === 'branch' ? entry.card.nodeId : String(entry.message.sequence);

/** The visible ⋯ of a message (X01: a message's menu, as well as long-press): What if… and Another perspective start here. */
function MessageMenuButton({
  message,
  onOpen,
}: {
  readonly message: AvailableMessage;
  readonly onOpen: (message: AvailableMessage) => void;
}) {
  return (
    <IconButton
      icon="more"
      label={`Options for ${message.author.displayName}’s message`}
      variant="plain"
      size={44}
      onPress={() => onOpen(message)}
    />
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
  /** The thread's branches, shown as cards among the messages (X02). */
  readonly branches: readonly ScenarioCard[];
  /** The branches this member opened, by node: their own history. */
  readonly openedBranches: readonly string[];
  readonly onOpenBranch: (card: ScenarioCard) => void;
  readonly onRemoveBranch: (card: ScenarioCard) => void;
  /** Asks What if… from a branch that is ready: the new one continues it. */
  readonly onContinueBranch: (card: ScenarioCard) => void;
  /** The message menu: What if… and Another perspective from this message. */
  readonly onMessageMenu: (message: AvailableMessage) => void;
  /** Starts a request from a message or a snippet card directly. */
  readonly onAsk: (message: AvailableMessage, kind: ScenarioKind) => void;
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
  branches,
  openedBranches,
  onOpenBranch,
  onRemoveBranch,
  onContinueBranch,
  onMessageMenu,
  onAsk,
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
        {dividedByDay(timeline(state.messages, branches)).map((group) => (
          <View key={group.key + entryKey(group.items[0])} style={styles.messages}>
            <Text variant="metaS" color={content.ink2} align="center">
              {dayLabel(group.at, now)}
            </Text>
            {group.items.map((entry) =>
              entry.kind === 'branch' ? (
                <View key={entry.card.nodeId} role="listitem" style={styles.branch}>
                  <BranchCard
                    card={entry.card}
                    starterIsYou={entry.card.startedBy?.personId === ownPersonId}
                    openedByYou={openedBranches.includes(entry.card.nodeId)}
                    startedLine={startedLine(entry.card, state.messages)}
                    onOpen={onOpenBranch}
                    onRemove={onRemoveBranch}
                    onContinue={onContinueBranch}
                  />
                </View>
              ) : (
                <View key={entry.message.sequence} role="listitem" style={styles.item}>
                  {entry.message.status === 'available' && !mineOf(entry.message) ? (
                    <Text variant="metaS" color={content.ink2}>
                      {entry.message.author.displayName}
                    </Text>
                  ) : null}
                  <View style={[styles.line, mineOf(entry.message) ? styles.mine : styles.theirs]}>
                    <Bubble
                      message={entry.message}
                      mine={mineOf(entry.message)}
                      partOf={partOf}
                      onOpenSnippet={onOpenSnippet}
                      onWhatIf={(message) => onAsk(message, 'what_if')}
                    />
                    {entry.message.status === 'available' ? (
                      <MessageMenuButton message={entry.message} onOpen={onMessageMenu} />
                    ) : null}
                  </View>
                </View>
              ),
            )}
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
  branch: { alignItems: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], maxWidth: '100%' },
  bubble: { maxWidth: '82%', borderRadius: radius.panel, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  snippet: { gap: spacing[2], maxWidth: '100%' },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing[1] },
  theirs: { alignSelf: 'flex-start' },
  mineBubble: { backgroundColor: content.accent },
  theirBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: content.ink },
  failedBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: status.danger.edge },
  removed: { backgroundColor: content.paper2, borderWidth: borderWidth.light, borderColor: content.muted },
  failure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
});
