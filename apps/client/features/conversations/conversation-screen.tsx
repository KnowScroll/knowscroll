import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TALK_QUERY_KEY,
  blockFriend,
  dayKey,
  dayLabel,
  findConversation,
  type AccountScope,
  type ThreadController,
  type ThreadState,
} from '@knowscroll/client-core';
import type { ConversationMessage, DirectConversationRef, PublicPersonRef } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { Composer } from './composer';
import { ConversationMenu } from './conversation-menu';
import { conversationRefFromParams } from './conversation-links';
import { MessageBubble, OutgoingBubble } from './message-views';
import { PersonAvatar } from './person-avatar';
import { useConversationThread } from './use-conversation-thread';

const draftKey = (conversationId: string) => `talk.draft.${conversationId}`;

function dividedByDay(messages: readonly ConversationMessage[]) {
  const groups: { key: string; at: Date; items: ConversationMessage[] }[] = [];
  for (const message of messages) {
    const at = message.status === 'available' ? new Date(message.recordedAt) : undefined;
    const last = groups.at(-1);
    // A tombstone has no time; it stays in the day of the message before it.
    if (at === undefined && last !== undefined) last.items.push(message);
    else if (last !== undefined && at !== undefined && last.key === dayKey(at)) last.items.push(message);
    else if (at !== undefined) groups.push({ key: dayKey(at), at, items: [message] });
    else groups.push({ key: 'removed', at: new Date(), items: [message] });
  }
  return groups;
}

function ThreadHeader({
  peer,
  fallbackName,
  onBack,
  onMenu,
}: {
  readonly peer: PublicPersonRef | undefined;
  readonly fallbackName: string;
  readonly onBack: () => void;
  readonly onMenu: (() => void) | undefined;
}) {
  return (
    <View style={styles.header}>
      <IconButton icon="back" label="Back to Talk" onPress={onBack} />
      {peer === undefined ? null : <PersonAvatar person={peer} size={40} />}
      <View style={styles.title}>
        <Text variant="title" heading={1} numberOfLines={1}>
          {peer?.displayName ?? fallbackName}
        </Text>
      </View>
      {onMenu === undefined ? null : <IconButton icon="more" label="Conversation options" onPress={onMenu} />}
    </View>
  );
}

function Thread({
  scope,
  controller,
  state,
  reference,
}: {
  readonly scope: AccountScope;
  readonly controller: ThreadController;
  readonly state: ThreadState;
  readonly reference: DirectConversationRef;
}) {
  const router = useRouter();
  const scroll = useRef<ScrollViewInstance>(null);
  const nearBottom = useRef(true);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(() => scope.storage.get(draftKey(reference.conversationId)) ?? '');
  const leaveToTalk = () => router.replace('/conversations');
  const name = state.peer?.displayName ?? 'this person';
  useDocumentTitle(state.peer?.displayName ?? 'Conversation');
  const keepDraft = (text: string) => {
    setDraft(text);
    if (text === '') scope.storage.remove(draftKey(reference.conversationId));
    else scope.storage.set(draftKey(reference.conversationId), text);
  };
  useEffect(() => {
    // New messages scroll into view only for a reader already at the bottom.
    if (nearBottom.current) scroll.current?.scrollToEnd({ animated: false });
  }, [state.messages.length, state.outgoing.length, state.phase]);

  if (state.phase === 'loading')
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading conversation" />
      </View>
    );
  if (state.phase === 'unavailable')
    return (
      <StateBlock
        title="This conversation isn’t available"
        body="It may have ended, or you may no longer have access."
        actions={[{ label: 'Back to Talk', role: 'link', href: '/conversations', onPress: leaveToTalk }]}
      />
    );
  if (state.phase === 'failed')
    return (
      <StateBlock
        title="Can’t open this conversation"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    );

  const mineOf = (message: ConversationMessage) =>
    message.status === 'available' && message.author.personId !== state.peer?.personId;
  const lastMineSequence = [...state.messages].reverse().find(mineOf)?.sequence;
  const now = new Date();
  return (
    <>
      <ThreadHeader
        peer={state.peer}
        fallbackName={name}
        onBack={() => (router.canGoBack() ? router.back() : leaveToTalk())}
        onMenu={() => setMenu(true)}
      />
      {state.offline ? (
        <View style={styles.banner}>
          <Banner kind="reconnecting" lead="Reconnecting…" message="Missing messages will appear in order." />
        </View>
      ) : null}
      {state.ended ? (
        <View style={styles.banner}>
          <Banner
            kind="accessEnded"
            lead={`${name} left this conversation.`}
            message="You can read it, but you can’t send anything more."
          />
        </View>
      ) : null}
      <ScrollView
        ref={scroll}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
        }}
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
      {state.ended ? null : (
        <Composer
          name={name}
          value={draft}
          onChange={keepDraft}
          onSend={(text) => {
            keepDraft('');
            nearBottom.current = true;
            void controller.send({ kind: 'text', text });
          }}
        />
      )}
      <ConversationMenu
        visible={menu}
        name={name}
        muted={state.muted}
        ended={state.ended}
        onClose={() => setMenu(false)}
        onMute={(muted) => void controller.mute(muted)}
        onLeave={() => {
          setMenu(false);
          void controller.leave().then((left) => {
            if (left) leaveToTalk();
          });
        }}
        onBlock={() => {
          setMenu(false);
          const peerId = state.peer?.personId;
          if (peerId === undefined) return;
          void blockFriend(scope, newCommandId, peerId).then((blocked) => {
            if (blocked) leaveToTalk();
            else void controller.refresh();
          });
        }}
      />
    </>
  );
}

function OpenThread({ scope, reference }: { readonly scope: AccountScope; readonly reference: DirectConversationRef }) {
  const { controller, state } = useConversationThread(scope, reference);
  return <Thread scope={scope} controller={controller} state={state} reference={reference} />;
}

/** The reference to open: carried by the address, or found in the person's own inbox by ID. */
function ResolvedThread({
  scope,
  params,
}: {
  readonly scope: AccountScope;
  readonly params: {
    readonly conversationId: string;
    readonly m?: string | undefined;
    readonly r?: string | undefined;
  };
}) {
  const router = useRouter();
  const carried = conversationRefFromParams(params);
  const lookup = useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'find', params.conversationId),
    enabled: carried === undefined,
    queryFn: async () => (await findConversation(scope, newCommandId, params.conversationId)) ?? null,
    staleTime: 60_000,
  });
  const reference = carried ?? lookup.data ?? undefined;
  if (reference !== undefined) return <OpenThread key={reference.conversationId} scope={scope} reference={reference} />;
  if (lookup.isPending)
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading conversation" />
      </View>
    );
  return (
    <StateBlock
      title="This conversation isn’t available"
      body="It may have ended, or you may no longer have access."
      actions={[
        {
          label: 'Back to Talk',
          role: 'link',
          href: '/conversations',
          onPress: () => router.replace('/conversations'),
        },
      ]}
    />
  );
}

/**
 * C02: one direct conversation. Messages are read in order from the server, new ones arrive on a
 * live hint (or the next poll, focus or reconnect), and a message being sent stays one bubble
 * until the server's receipt. Opening the thread and reading it records nothing about anyone.
 */
export function ConversationScreen(params: {
  readonly conversationId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
}) {
  const { state, manager } = useAccountScope();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {state.status === 'signed_in' ? (
        <ResolvedThread scope={state.scope} params={params} />
      ) : (
        <>
          <ThreadHeader
            peer={undefined}
            fallbackName="Conversation"
            onBack={() => router.replace('/conversations')}
            onMenu={undefined}
          />
          {state.status === 'unavailable' ? (
            <StateBlock
              title="Can’t reach your account"
              body="Reconnect to read this conversation."
              actions={[{ label: 'Reconnect', onPress: () => void manager.refresh() }]}
            />
          ) : (
            <StateBlock
              title="Sign in to read this conversation"
              actions={[
                {
                  label: 'Sign in',
                  variant: 'primary',
                  role: 'link',
                  href: '/welcome',
                  onPress: () => router.navigate('/welcome'),
                },
              ]}
            />
          )}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.regular,
    borderBottomColor: content.ink,
  },
  title: { flex: 1 },
  body: { padding: layout.gutter },
  banner: { paddingHorizontal: layout.gutter, paddingTop: spacing[3] },
  list: { flex: 1, backgroundColor: content.paper2 },
  listContent: { padding: layout.gutter, gap: spacing[3], flexGrow: 1, justifyContent: 'flex-end' },
  messages: { gap: spacing[3] },
  item: { gap: spacing[1] },
});
