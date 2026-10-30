import { useState, type ReactNode, type RefObject } from 'react';
import {
  Pressable,
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
  type OutgoingRoomMessage,
  type RoomDiscussionController,
  type RoomDiscussionState,
} from '@knowscroll/client-core';
import type { ConversationContentProjection, RoomMessage, ThreadEpisode } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, IconButton, Tag, Text } from '@knowscroll/ui';
import { SnippetCard } from '../threads/snippet-card';
import { FoldedResident, ResidentHeader } from './resident-message';

type Available = Extract<RoomMessage, { status: 'available' }>;

interface Group {
  readonly key: string;
  readonly at: Date;
  readonly items: RoomMessage[];
}

/** Messages grouped under a day label; a marker has no time and stays in the day before it. */
function dividedByDay(messages: readonly RoomMessage[]): Group[] {
  const groups: Group[] = [];
  for (const message of messages) {
    const at = message.status === 'available' ? new Date(message.recordedAt) : undefined;
    const last = groups.at(-1);
    if (at === undefined && last !== undefined) last.items.push(message);
    else if (last !== undefined && at !== undefined && last.key === dayKey(at)) last.items.push(message);
    else groups.push({ key: at === undefined ? 'removed' : dayKey(at), at: at ?? new Date(), items: [message] });
  }
  return groups;
}

const titleOf = (card: ConversationContentProjection): string | undefined =>
  card.status === 'available'
    ? card.metadata.title
    : card.status === 'corrected'
      ? card.current.metadata.title
      : undefined;

/** What the person can do with a message beyond reading it, found from the message and their role. */
export interface MessageActions {
  readonly canStartThread: boolean;
  readonly canModerate: boolean;
  /** Anyone can report a message that is not their own, an AI inhabitant's included (P03). */
  readonly canReport: boolean;
}

export function actionsFor(
  message: RoomMessage,
  role: 'member' | 'moderator',
  ownPersonId: string | undefined,
): MessageActions {
  const isCard = message.status === 'available' && message.body.kind === 'content';
  const mine =
    message.status === 'available' && message.author.kind === 'person' && message.author.personId === ownPersonId;
  return {
    canStartThread: isCard,
    canModerate: role === 'moderator' && (message.status === 'removed' || message.status === 'available'),
    canReport: message.status === 'available' && !mine,
  };
}

/** A card for current content shared into the discussion (not an anchored moment). */
function ContentCard({
  card,
  note,
  mine,
  onStartThread,
}: {
  readonly card: ConversationContentProjection;
  readonly note: string | undefined;
  readonly mine: boolean;
  readonly onStartThread: (() => void) | undefined;
}) {
  const metadata =
    card.status === 'available' ? card.metadata : card.status === 'corrected' ? card.current.metadata : undefined;
  return (
    <View style={[styles.card, mine ? styles.mine : styles.theirs]}>
      {metadata === undefined ? (
        <Text variant="meta" color={content.ink2}>
          No longer available
        </Text>
      ) : (
        <>
          <View style={styles.cardTags}>
            <Tag label={metadata.kind === 'reel' ? 'Reel' : 'Scroll'} />
            {card.status === 'corrected' ? <Tag variant="corrected" label="Updated" /> : null}
          </View>
          <Text variant="ui" numberOfLines={2}>
            {metadata.title}
          </Text>
        </>
      )}
      {note === undefined ? null : <Text variant="bodyS">{note}</Text>}
      {onStartThread === undefined || metadata === undefined ? null : (
        <Button label="Start a thread" size="sm" onPress={onStartThread} testID="start-thread" />
      )}
    </View>
  );
}

function Bubble({
  message,
  mine,
  partOf,
  actions,
  onOpenSnippet,
  onStartThread,
}: {
  readonly message: Available;
  readonly mine: boolean;
  readonly partOf: (assetId: string) => string | undefined;
  readonly actions: MessageActions;
  readonly onOpenSnippet: (messageId: string) => void;
  readonly onStartThread: (messageId: string) => void;
}) {
  const align = mine ? styles.mine : styles.theirs;
  const { body } = message;
  if (body.kind === 'snippet') {
    const target = body.snippet.content.target;
    return (
      <View style={[styles.snippet, align]}>
        {body.note === undefined ? null : (
          <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble]}>
            <Text variant="bodyS" color={mine ? content.onAccent : content.ink} selectable>
              {body.note}
            </Text>
          </View>
        )}
        <SnippetCard
          snippet={body.snippet}
          partLabel={partOf(target.assetId)}
          onOpen={() => onOpenSnippet(message.messageId)}
        />
      </View>
    );
  }
  if (body.kind === 'content')
    return (
      <ContentCard
        card={body.content}
        note={body.note}
        mine={mine}
        onStartThread={actions.canStartThread ? () => onStartThread(message.messageId) : undefined}
      />
    );
  // An AI contribution: dotted outline and a square corner beside its label, never colour alone.
  if (message.author.kind === 'ai')
    return (
      <View style={[styles.bubble, styles.aiBubble, align]} testID="ai-message">
        <Text variant="bodyS" selectable>
          {body.text}
        </Text>
      </View>
    );
  return (
    <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble, align]}>
      <Text variant="bodyS" color={mine ? content.onAccent : content.ink} selectable>
        {body.text}
      </Text>
    </View>
  );
}

/**
 * One message and its ⋯ (R02). The ⋯ is not drawn until the pointer is over the message or the control
 * itself has focus, and a long press anywhere on the message opens the same sheet, so a quiet discussion
 * is not a column of buttons. It stays in the page, and keeps its touch, so keyboards, VoiceOver and
 * TalkBack reach it (a pointer over the message reveals it before it can be clicked). Focus is the
 * control's own: a Pressable around it would not hear a child's focus on the web.
 */
function MessageLine({
  sequence,
  children,
  hasActions,
  onActions,
}: {
  readonly sequence: number;
  readonly children: ReactNode;
  readonly hasActions: boolean;
  readonly onActions: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const revealed = hovered || focused;
  return (
    <Pressable
      accessible={false}
      focusable={false}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onLongPress={hasActions ? onActions : undefined}
      style={styles.line}
      testID={`message-${String(sequence)}`}
    >
      <View style={styles.lineBody}>{children}</View>
      {hasActions ? (
        <View style={revealed ? null : styles.hidden} testID={`message-options-${String(sequence)}`}>
          <IconButton
            icon="more"
            label="Message options"
            onPress={onActions}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

function Marker({ words, mine }: { readonly words: string; readonly mine: boolean }) {
  return (
    <View style={[styles.bubble, styles.removed, mine ? styles.mine : styles.theirs]}>
      <Text variant="meta" color={content.ink2}>
        {words}
      </Text>
    </View>
  );
}

function OutgoingBubble({
  entry,
  onRetry,
  onDismiss,
}: {
  readonly entry: OutgoingRoomMessage;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const failed = entry.status === 'unconfirmed' || entry.status === 'not_sent';
  const words =
    entry.body.kind === 'text'
      ? entry.body.text
      : entry.body.kind === 'content'
        ? 'Sharing…'
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

export interface RoomMessagesProps {
  readonly state: RoomDiscussionState;
  readonly controller: RoomDiscussionController;
  readonly role: 'member' | 'moderator';
  /** The caller's own public person ID: their messages sit on the right. */
  readonly ownPersonId: string | undefined;
  readonly episodes: readonly ThreadEpisode[];
  readonly series: boolean;
  readonly scrollRef: RefObject<ScrollViewInstance | null>;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onOpenSnippet: (messageId: string) => void;
  readonly onStartThread: (messageId: string) => void;
  /** Opens the message's actions (moderator tools, starting a thread). */
  readonly onActions: (message: RoomMessage) => void;
}

/**
 * The discussion's messages by day. A person's name sits above each other person's bubble; an AI
 * inhabitant's label sits above its bubble and the bubble is dotted with a square corner; a removed
 * message and a deleted account's message are markers that keep their place.
 */
export function RoomMessages({
  state,
  controller,
  role,
  ownPersonId,
  episodes,
  series,
  scrollRef,
  onScroll,
  onOpenSnippet,
  onStartThread,
  onActions,
}: RoomMessagesProps) {
  const now = new Date();
  const partOf = (assetId: string) => {
    const part = series ? episodes.find((episode) => episode.assetId === assetId)?.part : undefined;
    return part === undefined ? undefined : `Part ${String(part)}`;
  };
  const mineOf = (message: RoomMessage) =>
    message.status === 'available' && message.author.kind === 'person' && message.author.personId === ownPersonId;
  // A moderator who blocked an author still has to moderate them: their words arrive collapsed, and stay so
  // until the moderator asks to see them (on this screen only; nothing is remembered).
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const toggleShown = (messageId: string) =>
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  const collapsedOf = (message: RoomMessage) =>
    message.status === 'available' && message.blockedByYou === true && !shown.has(message.messageId);
  // A Quieter reader sees a resident's unprompted message as one line until they ask for the words.
  const foldedOf = (message: RoomMessage) =>
    message.status === 'available' && message.folded === true && !shown.has(message.messageId);
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      onScroll={onScroll}
      scrollEventThrottle={100}
      testID="room-messages"
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
        <View style={styles.quiet}>
          <Text variant="ui" align="center">
            It’s quiet here right now
          </Text>
          <Text variant="meta" color={content.ink2} align="center">
            Say something, or ask an AI inhabitant. They answer when asked, and may join in when a question goes
            unanswered.
          </Text>
        </View>
      ) : null}
      <View role="list" accessibilityLabel="Messages in this discussion" style={styles.messages}>
        {dividedByDay(state.messages).map((group) => (
          <View key={group.key + String(group.items[0]?.sequence)} style={styles.messages}>
            <Text variant="metaS" color={content.ink2} align="center">
              {dayLabel(group.at, now)}
            </Text>
            {group.items.map((message) => {
              // A resident spoke on its own and this reader's AI level is Off: nothing is drawn, not even a marker.
              if (message.status === 'muted') return null;
              const actions = actionsFor(message, role, ownPersonId);
              const mine = mineOf(message);
              const folded = foldedOf(message);
              return (
                <View key={message.sequence} role="listitem" style={styles.item}>
                  {message.status === 'available' && folded && message.author.kind === 'ai' ? (
                    <FoldedResident name={message.author.name} onShow={() => toggleShown(message.messageId)} />
                  ) : message.status === 'available' && !collapsedOf(message) ? (
                    message.author.kind === 'ai' ? (
                      <ResidentHeader
                        name={message.author.name}
                        label={message.author.label}
                        suggestion={message.suggestion}
                        trigger={message.trigger}
                      />
                    ) : mine ? null : (
                      <Text variant="metaS" color={content.ink2}>
                        {message.author.displayName}
                      </Text>
                    )
                  ) : null}
                  {folded ? null : (
                    <MessageLine
                      sequence={message.sequence}
                      hasActions={actions.canStartThread || actions.canModerate || actions.canReport}
                      onActions={() => onActions(message)}
                    >
                      {message.status === 'available' && collapsedOf(message) ? (
                        <View style={styles.collapsed} testID="blocked-collapsed">
                          <Marker words="A message from someone you blocked" mine={false} />
                          <Button
                            label="Show for moderation"
                            size="sm"
                            variant="ghost"
                            onPress={() => toggleShown(message.messageId)}
                            testID={`show-blocked-${message.messageId}`}
                          />
                        </View>
                      ) : message.status === 'available' ? (
                        <>
                          <Bubble
                            message={message}
                            mine={mine}
                            partOf={partOf}
                            actions={actions}
                            onOpenSnippet={onOpenSnippet}
                            onStartThread={onStartThread}
                          />
                          {message.blockedByYou === true ? (
                            <View style={styles.revealed}>
                              <Text variant="metaS" color={content.ink2}>
                                You blocked this person. Shown for moderation.
                              </Text>
                              <Button
                                label="Hide again"
                                size="sm"
                                variant="ghost"
                                onPress={() => toggleShown(message.messageId)}
                              />
                            </View>
                          ) : null}
                        </>
                      ) : message.status === 'removed' ? (
                        <Marker words="Message removed by the moderator" mine={false} />
                      ) : message.status === 'blocked' ? (
                        <Marker words="A message from someone you blocked" mine={false} />
                      ) : (
                        <Marker words="Message removed" mine={false} />
                      )}
                    </MessageLine>
                  )}
                  {message.status === 'available' && message.author.kind === 'ai' && !folded ? (
                    <Text variant="metaS" color={content.ink2}>
                      A suggestion. Nothing is made unless someone chooses it.
                    </Text>
                  ) : null}
                </View>
              );
            })}
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

/** The words a screen reader gets for a content card, used by the options sheet. */
export function cardWords(message: RoomMessage): string | undefined {
  if (message.status !== 'available') return undefined;
  if (message.body.kind === 'content') return titleOf(message.body.content);
  if (message.body.kind === 'snippet') return titleOf(message.body.snippet.content);
  return undefined;
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
  quiet: {
    gap: spacing[1],
    padding: spacing[4],
    alignItems: 'center',
    borderRadius: radius.lg,
    backgroundColor: content.paper,
    borderWidth: borderWidth.light,
    borderColor: content.rule,
  },
  item: { gap: spacing[1] },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  lineBody: { flex: 1 },
  hidden: { opacity: 0 },
  collapsed: { gap: spacing[1], alignItems: 'flex-start' },
  revealed: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  bubble: { maxWidth: '82%', borderRadius: radius.panel, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  snippet: { gap: spacing[2], maxWidth: '100%' },
  card: {
    gap: spacing[2],
    maxWidth: '82%',
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  cardTags: { flexDirection: 'row', gap: spacing[2] },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing[1] },
  theirs: { alignSelf: 'flex-start' },
  mineBubble: { backgroundColor: content.accent },
  theirBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: content.ink },
  /** Dotted outline and a square top-left corner mark an AI inhabitant's words without colour. */
  aiBubble: {
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderStyle: 'dotted',
    borderTopLeftRadius: radius.xs,
  },
  failedBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: status.danger.edge },
  removed: {
    backgroundColor: content.paper2,
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderStyle: 'dashed',
  },
  failure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
});
