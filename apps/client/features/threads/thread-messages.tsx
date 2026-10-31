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
  capsuleLabel,
  clockTime,
  dayKey,
  endsRun,
  type ContentThreadController,
  type ContentThreadState,
  type OutgoingMessage,
  type OutgoingThreadMessage,
  type RunStep,
} from '@knowscroll/client-core';
import type {
  MessageReactionKind,
  ScenarioCard,
  ScenarioKind,
  ThreadEpisode,
  ThreadMessage,
} from '@knowscroll/contracts';
import { layout, spacing } from '@knowscroll/design-tokens';
import { Button, DateCapsule, MenuRow, TalkBubble, Text, useDisplay, useTalkTheme } from '@knowscroll/ui';
import { AwayDivider, firstAwayMessage, OutgoingBubble, RemovedMessage } from '../conversations/message-views';
import { TalkMessage, type AvailableTalkMessage, type TalkMessageBody } from '../conversations/talk-message';
import { useMessageJump } from '../conversations/use-message-jump';
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

/** Entries grouped under a day capsule; one with no time (a tombstone) stays in the day before it. */
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

/** A message as the grouping into runs sees it; a branch card or a removed message has none and breaks the run. */
function runStepOf(entry: Entry | undefined): RunStep | undefined {
  return entry?.kind === 'message' && entry.message.status === 'available'
    ? { authorId: entry.message.author.personId, at: new Date(entry.message.recordedAt) }
    : undefined;
}

/** The time to show under this entry: only the last message of a run carries one. */
function runEndTime(entry: Entry, next: Entry | undefined): Date | undefined {
  const step = runStepOf(entry);
  return step !== undefined && endsRun(step, runStepOf(next)) ? step.at : undefined;
}

/** The time under the last message of a run, on the side the bubbles of that run sit. */
function RunTime({ at, mine }: { readonly at: Date | undefined; readonly mine: boolean }) {
  const theme = useTalkTheme();
  if (at === undefined) return null;
  return (
    <Text variant="monoXs" color={theme.textQuiet} align={mine ? 'right' : 'left'} testID="message-time">
      {clockTime(at)}
    </Text>
  );
}

/** Where a branch began, in words: the whole thread, a shared moment or passage, or someone's message. */
function startedLine(card: ScenarioCard, messages: readonly ThreadMessage[]): string {
  if (card.parentNodeId !== undefined) return 'from another branch';
  if (card.origin === 'root' || card.originMessageId === undefined) return 'from the thread';
  if (card.origin === 'snippet') return 'from a shared moment or passage';
  const message = messages.find((candidate) => candidate.messageId === card.originMessageId);
  return message?.status === 'available' ? `from ${message.author.displayName}’s message` : 'from a message';
}

const entryKey = (entry: Entry | undefined): string =>
  entry === undefined ? '' : entry.kind === 'branch' ? entry.card.nodeId : String(entry.message.sequence);

/** What a message says: its words, or the snippet it shares (with the note above it and What if… below). */
function bodyOf(
  message: AvailableMessage,
  mine: boolean,
  partOf: (assetId: string) => string | undefined,
  onOpenSnippet: (messageId: string) => void,
  onWhatIf: (message: AvailableMessage) => void,
  theme: ReturnType<typeof useTalkTheme>,
): TalkMessageBody {
  if (message.body.kind === 'text') return { kind: 'text', text: message.body.text };
  const { snippet, note } = message.body;
  return {
    kind: 'card',
    node: (
      <View style={styles.snippet}>
        {note === undefined ? null : (
          <TalkBubble mine={mine} tail={false}>
            <Text variant="bubble" color={mine ? theme.bubbleOwn.text : theme.bubbleOther.text} selectable>
              {note}
            </Text>
          </TalkBubble>
        )}
        <SnippetCard
          snippet={snippet}
          partLabel={partOf(snippet.content.target.assetId)}
          onOpen={() => onOpenSnippet(message.messageId)}
        />
        {snippet.content.status === 'unavailable' ? null : (
          <Button label="What if…" size="sm" variant="space" icon="hypothetical" onPress={() => onWhatIf(message)} />
        )}
      </View>
    ),
  };
}

/** A sending bubble: its words, or what a shared moment is called while it goes. */
function outgoingAsMessage(entry: OutgoingThreadMessage): OutgoingMessage {
  const words =
    entry.body.kind === 'text'
      ? entry.body.text
      : entry.body.anchor.kind === 'reel_range'
        ? 'Sharing a moment…'
        : entry.body.anchor.kind === 'scroll_passage'
          ? 'Sharing a passage…'
          : 'Sharing a part of a Scroll…';
  return {
    commandId: entry.commandId,
    status: entry.status,
    body: { kind: 'text', text: words },
    ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo }),
  };
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
  /** Starts a request from a message or a snippet card (What if…, Another perspective). */
  readonly onAsk: (message: AvailableMessage, kind: ScenarioKind) => void;
  /** Starts a reply to a message (the chip waits in the message box). */
  readonly onReply: (message: AvailableTalkMessage) => void;
  /** Reports another person's message. */
  readonly onReport: (message: AvailableTalkMessage) => void;
}

/**
 * The thread's messages by day, in the Talk look: a capsule for every day, the author named above each
 * other person's run, bubbles with the time under the last of each, and what is still being sent. A
 * message has the whole menu (reply, react, copy, report, and What if… and Another perspective) and a
 * reply's quote jumps to its original.
 */
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
  onAsk,
  onReply,
  onReport,
}: ThreadMessagesProps) {
  const theme = useTalkTheme();
  const { reducedMotion } = useDisplay();
  const jumper = useMessageJump(scrollRef, reducedMotion);
  const now = new Date();
  const series = state.sequence === 'series';
  const partOf = (assetId: string) => {
    const part = series ? episodes.find((episode) => episode.assetId === assetId)?.part : undefined;
    return part === undefined ? undefined : `Part ${String(part)}`;
  };
  const mineOf = (message: ThreadMessage) => message.status === 'available' && message.author.personId === ownPersonId;
  const awayFrom = firstAwayMessage(state.messages, state.awayAfterSequence);
  const jump = (sequence: number) =>
    void jumper.jump(sequence, { hasOlder: () => controller.getState().hasOlder, loadOlder: controller.loadOlder });
  const react = (message: AvailableTalkMessage, kind: MessageReactionKind, present: boolean) =>
    void controller.react(message.messageId, kind, present);
  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.list, { backgroundColor: theme.ground }]}
      contentContainerStyle={styles.listContent}
      onScroll={onScroll}
      scrollEventThrottle={100}
      testID="thread-messages"
    >
      {state.hasOlder ? (
        <Button
          label="Earlier messages"
          size="sm"
          variant="space"
          busy={state.loadingOlder}
          busyLabel="Loading"
          onPress={() => void controller.loadOlder()}
        />
      ) : null}
      {state.messages.length === 0 && state.outgoing.length === 0 ? (
        <Text variant="meta" color={theme.textQuiet} align="center">
          Nothing said yet. Say why you’re sharing it, or let it speak.
        </Text>
      ) : null}
      <View style={styles.messages}>
        {dividedByDay(timeline(state.messages, branches)).map((group) => (
          <View key={group.key + entryKey(group.items[0])} style={styles.messages}>
            <DateCapsule label={capsuleLabel(group.at, now)} />
            <View
              role="list"
              accessibilityLabel={`Messages in this thread, ${capsuleLabel(group.at, now)}`}
              style={styles.messages}
            >
              {group.items.map((entry, index) =>
                entry.kind === 'branch' ? (
                  <View key={entry.card.nodeId} role="listitem" style={styles.branch}>
                    <BranchCard
                      card={entry.card}
                      starterIsYou={entry.card.startedBy?.personId === ownPersonId}
                      openedByYou={openedBranches.includes(entry.card.nodeId)}
                      startedLine={startedLine(entry.card, state.messages)}
                      now={now}
                      onOpen={onOpenBranch}
                      onRemove={onRemoveBranch}
                      onContinue={onContinueBranch}
                    />
                  </View>
                ) : (
                  <View
                    key={entry.message.sequence}
                    ref={jumper.register(entry.message.sequence)}
                    collapsable={false}
                    role="listitem"
                    style={styles.item}
                  >
                    {entry.message.sequence === awayFrom ? <AwayDivider /> : null}
                    {entry.message.status === 'unavailable' ? (
                      <RemovedMessage mine={mineOf(entry.message)} />
                    ) : (
                      <>
                        {mineOf(entry.message) ? null : (
                          <Text variant="metaS" color={theme.textQuiet}>
                            {entry.message.author.displayName}
                          </Text>
                        )}
                        <TalkMessage
                          message={entry.message}
                          all={state.messages}
                          mine={mineOf(entry.message)}
                          tail={runEndTime(entry, group.items[index + 1]) !== undefined}
                          ownPersonId={ownPersonId}
                          flash={jumper.lit === entry.message.sequence ? jumper.flash : undefined}
                          open
                          body={bodyOf(
                            entry.message,
                            mineOf(entry.message),
                            partOf,
                            onOpenSnippet,
                            (message) => onAsk(message, 'what_if'),
                            theme,
                          )}
                          onReply={onReply}
                          onReact={react}
                          onReport={mineOf(entry.message) ? undefined : onReport}
                          onJump={jump}
                          extraRows={(close) =>
                            entry.message.status === 'available' ? (
                              <AskRows
                                message={entry.message}
                                onAsk={(message, kind) => {
                                  close();
                                  onAsk(message, kind);
                                }}
                              />
                            ) : null
                          }
                        />
                      </>
                    )}
                    <RunTime at={runEndTime(entry, group.items[index + 1])} mine={mineOf(entry.message)} />
                  </View>
                ),
              )}
            </View>
          </View>
        ))}
        {state.outgoing.length === 0 ? null : (
          <View role="list" accessibilityLabel="Messages being sent" style={styles.messages}>
            {state.outgoing.map((entry) => (
              <View key={entry.commandId} role="listitem">
                <OutgoingBubble
                  entry={outgoingAsMessage(entry)}
                  onRetry={() => void controller.retry(entry.commandId)}
                  onDismiss={() => controller.dismiss(entry.commandId)}
                  onSendWithoutQuote={() => void controller.sendWithoutQuote(entry.commandId)}
                />
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

/** What if… and Another perspective, from one message's menu (X01). */
function AskRows({
  message,
  onAsk,
}: {
  readonly message: AvailableMessage;
  readonly onAsk: (message: AvailableMessage, kind: ScenarioKind) => void;
}) {
  return (
    <>
      <MenuRow icon="hypothetical" label="What if…" onPress={() => onAsk(message, 'what_if')} testID="menu-what-if" />
      <MenuRow
        icon="arrowRight"
        label="Another perspective"
        onPress={() => onAsk(message, 'perspective')}
        testID="menu-perspective"
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
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
  snippet: { gap: spacing[2], maxWidth: '100%' },
});
