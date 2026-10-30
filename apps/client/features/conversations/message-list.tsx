import { useEffect, useRef, type RefObject } from 'react';
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
  type RunStep,
  type ThreadController,
  type ThreadState,
} from '@knowscroll/client-core';
import type { ConversationMessage, MessageReactionKind } from '@knowscroll/contracts';
import { layout, spacing } from '@knowscroll/design-tokens';
import { Button, DateCapsule, Text, useDisplay, useTalkTheme } from '@knowscroll/ui';
import { AwayDivider, ContentCard, firstAwayMessage, OutgoingBubble, RemovedMessage } from './message-views';
import { rootOfCard, type ThreadRoot } from './start-thread-sheet';
import { TalkMessage, type AvailableTalkMessage, type TalkMessageBody } from './talk-message';
import { useMessageJump } from './use-message-jump';

/** How close to the end still counts as "reading the latest" (px). */
const NEAR_END = 80;

type Available = Extract<ConversationMessage, { status: 'available' }>;

/** Messages grouped under a day capsule; a tombstone has no time and stays in the day before it. */
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

/** A message as the grouping into runs sees it; a removed message has none and breaks the run. */
const stepOf = (message: ConversationMessage | undefined): RunStep | undefined =>
  message?.status === 'available' ? { authorId: message.author.personId, at: new Date(message.recordedAt) } : undefined;

/** The time under the last message of a run, on the side its bubbles sit; "Sent" joins it under the person's own latest. */
function RunTime({ at, mine, sent }: { readonly at: Date; readonly mine: boolean; readonly sent: boolean }) {
  const theme = useTalkTheme();
  return (
    <Text variant="monoXs" color={theme.textQuiet} align={mine ? 'right' : 'left'} testID="message-time">
      {sent ? `${clockTime(at)} · Sent` : clockTime(at)}
    </Text>
  );
}

/** The reader's own public person ID, which a direct conversation does not carry: it is the author who is not the peer. */
function ownPersonIdOf(state: ThreadState): string | undefined {
  const peer = state.peer?.personId;
  for (const message of state.messages) {
    if (message.status !== 'available') continue;
    if (message.author.personId !== peer) return message.author.personId;
    for (const reaction of message.reactions ?? [])
      for (const person of reaction.people) if (person.personId !== peer) return person.personId;
  }
  return undefined;
}

export interface MessageListProps {
  readonly state: ThreadState;
  readonly controller: ThreadController;
  readonly name: string;
  /** From `useFollowEnd`: the scroll view's ref and scroll handler. */
  readonly scrollRef: RefObject<ScrollViewInstance | null>;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Reports another person's message. */
  readonly onReport: (message: Available) => void;
  /** Starts a reply to a message (the chip waits in the message box). */
  readonly onReply: (message: AvailableTalkMessage) => void;
  /** Starts a thread about a shared card with the other person. Absent once the conversation ended. */
  readonly onWatchTogether?: ((root: ThreadRoot) => void) | undefined;
}

/**
 * The messages by day, in the Talk look: a capsule for every day, bubbles in runs with the time under the
 * last of each, and the ones still being sent. A reply quotes its original and jumps to it; a message can
 * be replied to, reacted to, copied and reported (`TalkMessage`).
 */
export function MessageList({
  state,
  controller,
  name,
  scrollRef,
  onScroll,
  onReport,
  onReply,
  onWatchTogether,
}: MessageListProps) {
  const theme = useTalkTheme();
  const { reducedMotion } = useDisplay();
  const jumper = useMessageJump(scrollRef, reducedMotion);
  const mineOf = (message: ConversationMessage) =>
    message.status === 'available' && message.author.personId !== state.peer?.personId;
  const lastMineSequence = [...state.messages].reverse().find(mineOf)?.sequence;
  const ownPersonId = ownPersonIdOf(state);
  const now = new Date();
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
      testID="conversation-messages"
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
          No messages yet. Say hello.
        </Text>
      ) : null}
      <View style={styles.messages}>
        {dividedByDay(state.messages).map((group) => (
          <View key={group.key + String(group.items[0]?.sequence)} style={styles.messages}>
            <DateCapsule label={capsuleLabel(group.at, now)} />
            <View
              role="list"
              accessibilityLabel={`Messages with ${name}, ${capsuleLabel(group.at, now)}`}
              style={styles.messages}
            >
              {group.items.map((message, index) => {
                const mine = mineOf(message);
                const step = stepOf(message);
                const lastOfRun = step !== undefined && endsRun(step, stepOf(group.items[index + 1]));
                return (
                  <View
                    key={message.sequence}
                    ref={jumper.register(message.sequence)}
                    collapsable={false}
                    role="listitem"
                    style={styles.item}
                  >
                    {message.sequence === awayFrom ? <AwayDivider /> : null}
                    {message.status === 'unavailable' ? (
                      <RemovedMessage mine={mine} />
                    ) : (
                      <TalkMessage
                        message={message}
                        all={state.messages}
                        mine={mine}
                        tail={lastOfRun}
                        ownPersonId={ownPersonId}
                        flash={jumper.lit === message.sequence ? jumper.flash : undefined}
                        open={!state.ended}
                        body={bodyOf(message, onWatchTogether)}
                        onReply={onReply}
                        onReact={react}
                        onReport={mine ? undefined : () => onReport(message)}
                        onJump={jump}
                      />
                    )}
                    {lastOfRun && step !== undefined ? (
                      <RunTime
                        at={step.at}
                        mine={mine}
                        sent={mine && message.sequence === lastMineSequence && state.outgoing.length === 0}
                      />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        ))}
        {state.outgoing.length === 0 ? null : (
          <View role="list" accessibilityLabel="Messages being sent" style={styles.messages}>
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
        )}
      </View>
    </ScrollView>
  );
}

/** What a message says: its words, or the card it shares with a way to watch it together. */
function bodyOf(message: Available, onWatchTogether: MessageListProps['onWatchTogether']): TalkMessageBody {
  const { body } = message;
  if (body.kind === 'text') return { kind: 'text', text: body.text };
  const root = rootOfCard(body.content);
  return {
    kind: 'card',
    node: (
      <ContentCard
        card={body.content}
        note={body.note}
        onWatchTogether={onWatchTogether === undefined || root === undefined ? undefined : () => onWatchTogether(root)}
      />
    ),
  };
}

const styles = StyleSheet.create({
  list: { flex: 1 },
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
