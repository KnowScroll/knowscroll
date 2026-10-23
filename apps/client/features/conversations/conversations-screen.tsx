import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { useFriendsSession } from '../friends/use-friends-session';
import { FriendIdentity } from '../friends/friend-controls';
import { useConversationsSession } from './use-conversations-session';
import { EmptyTalkScreen } from './empty-talk-screen';

export function ConversationsScreen() {
  const { state, manager } = useAccountScope();
  const router = useRouter();
  if (state.status !== 'signed_in')
    return (
      <ScreenFrame tone="paper" title="Talk" bodyOffset={24}>
        <Text variant="title">Your conversations</Text>
        <Text variant="body">
          {state.status === 'unavailable'
            ? 'We can’t reach your account. Try again when connected.'
            : 'Sign in to talk with your friends.'}
        </Text>
        <Button
          label={state.status === 'unavailable' ? 'Try again' : 'Sign in'}
          role={state.status === 'unavailable' ? 'button' : 'link'}
          href={state.status === 'unavailable' ? undefined : '/welcome'}
          onPress={() => {
            if (state.status === 'unavailable') void manager.refresh();
            else router.push('/welcome');
          }}
        />
        <Button
          label="Go to Explore"
          role="link"
          href="/explore"
          variant="ghost"
          onPress={() => router.navigate('/explore')}
        />
      </ScreenFrame>
    );
  return <SignedInConversations scope={state.scope} />;
}
export function SignedInConversations({ scope }: { readonly scope: AccountScope }) {
  const { session, state } = useConversationsSession(scope);
  const friends = useFriendsSession(scope);
  const [chooser, setChooser] = useState(false);
  const [notice, setNotice] = useState('');
  const friendSnapshot = useCallback(() => friends?.getState(), [friends]);
  const friendSubscribe = useCallback(
    (listener: () => void) => friends?.subscribe(listener) ?? (() => undefined),
    [friends],
  );
  const friendView = useSyncExternalStore(friendSubscribe, friendSnapshot, friendSnapshot);
  const live = useRef(true);
  const router = useRouter();
  useEffect(() => {
    live.current = true;
    const off = scope.onEnd?.(() => {
      live.current = false;
      setChooser(false);
      setNotice('');
    });
    return () => {
      live.current = false;
      off?.();
    };
  }, [scope]);
  useFocusEffect(
    useCallback(() => {
      if (scope.active) void session.refreshInbox();
    }, [scope, session]),
  );
  const chooseFriend = async () => {
    if (!scope.active || state.status !== 'active') return;
    setChooser(true);
    if (friends) await friends.selectFilter('friends');
  };
  const start = async (personId: string) => {
    if (!live.current || !scope.active) return;
    setNotice('');
    const before = session.getState().command;
    await session.start(personId);
    if (!live.current || !scope.active) return;
    const command = session.getState().command;
    if (
      command.status === 'accepted' &&
      command.operation === 'start' &&
      (!('commandId' in before) || before.commandId.toLowerCase() !== command.commandId.toLowerCase())
    ) {
      setChooser(false);
      setNotice('Conversation started. Open it from Talk.');
      await session.refreshInbox();
    }
  };
  if (!scope.active || state.status !== 'active')
    return (
      <ScreenFrame tone="paper" title="Talk" bodyOffset={24}>
        <Text variant="body">This signed-in session ended.</Text>
      </ScreenFrame>
    );
  const page = state.inbox.status === 'ready' && state.inbox.data.status === 'ready' ? state.inbox.data : undefined;
  if (
    page &&
    !page.items.length &&
    page.continuation.kind === 'end' &&
    !chooser &&
    !notice &&
    !state.failure &&
    state.command.status === 'idle' &&
    !state.drafts.length
  )
    return (
      <EmptyTalkScreen
        onNewMessage={() => {
          void chooseFriend();
        }}
      />
    );
  return (
    <ScreenFrame tone="paper" title="Talk" bodyOffset={24}>
      <View style={talkStyles.measure}>
        <View style={talkStyles.actions}>
          <Button
            label="New message"
            onPress={() => {
              void chooseFriend();
            }}
            disabled={state.mutationBlocked || state.status !== 'active'}
          />
          <Button label="Friends" role="link" href="/friends" variant="ghost" onPress={() => router.push('/friends')} />
          <Button
            label="Refresh conversations"
            variant="ghost"
            onPress={() => {
              void session.refreshInbox();
            }}
            disabled={state.inbox.status === 'loading'}
          />
        </View>
        {notice ? <Text variant="bodyS">{notice}</Text> : null}
        {chooser ? (
          <View style={talkStyles.card}>
            <Text variant="title" heading={2}>
              Message a friend
            </Text>
            <Text variant="bodyS">Choose a current friend. Starting a conversation sends no message.</Text>
            {friendView?.roster.status === 'loading' ? <Text variant="bodyS">Loading friends…</Text> : null}
            {friendView?.roster.status === 'ready'
              ? friendView.roster.data.items.map((pair) => (
                  <View key={pair.peer.personId} style={talkStyles.row}>
                    <FriendIdentity person={pair.peer} />
                    <Button
                      label={`Message ${pair.peer.displayName}`}
                      disabled={state.mutationBlocked}
                      onPress={() => {
                        void start(pair.peer.personId);
                      }}
                    />
                  </View>
                ))
              : null}
            {friendView?.roster.status === 'ready' && !friendView.roster.data.items.length ? (
              <Text variant="bodyS">
                {friendView.canNext
                  ? 'No friends in this part of the list. More can be checked.'
                  : 'No current friends in this list.'}
              </Text>
            ) : null}
            {friendView?.roster.status === 'unavailable' ? (
              <Text variant="bodyS">Friends couldn’t be loaded. Refresh before choosing.</Text>
            ) : null}
            <View style={talkStyles.actions}>
              <Button
                label="Refresh friends"
                variant="ghost"
                onPress={() => {
                  void friends?.selectFilter('friends');
                }}
              />
              {friendView?.canNext ? (
                <Button
                  label="More friends"
                  variant="ghost"
                  onPress={() => {
                    void friends?.nextPage();
                  }}
                />
              ) : null}
              <Button label="Close friend picker" variant="ghost" onPress={() => setChooser(false)} />
            </View>
          </View>
        ) : null}
        {state.inbox.status === 'loading' ? <Text variant="bodyS">Loading conversations…</Text> : null}
        {state.inbox.status === 'unavailable' ? (
          <Text variant="bodyS">
            Conversations couldn’t be checked. Your draft stays here for this signed-in session. Messages won’t send
            automatically.
          </Text>
        ) : null}
        {state.inbox.status === 'ready' && state.inbox.data.status === 'refresh_required' ? (
          <Text variant="bodyS">This list needs a fresh read. Refresh conversations to continue.</Text>
        ) : null}
        {page?.items.length === 0 ? (
          <Text variant="body">
            {page.continuation.kind === 'more'
              ? 'No conversations in this part of the list. More can be checked.'
              : 'No conversations yet. Choose a friend to begin.'}
          </Text>
        ) : null}
        {page?.items.map((item) => {
          const href = `/conversations/${item.conversation.conversationId}`;
          const unread = item.latestMessageSequence > item.own.readThroughSequence;
          const last = item.lastMessage;
          const preview = !last
            ? 'No messages yet'
            : last.status === 'unavailable'
              ? 'Message unavailable'
              : last.body.kind === 'text'
                ? last.body.text
                : 'Shared content';
          return (
            <View key={item.conversation.conversationId} style={talkStyles.row}>
              <Text variant="ui">
                {unread ? '● ' : ''}
                {item.peer.displayName}
                {item.own.muted ? ' · Muted' : ''}
              </Text>
              <Text variant="bodyS" numberOfLines={2} color={content.ink2}>
                {preview}
              </Text>
              <Button
                label={`Open ${item.peer.displayName}${unread ? ', unread' : ''}`}
                role="link"
                href={href}
                variant="ghost"
                onPress={() => {
                  void session.open(item.conversation);
                  router.push(href);
                }}
              />
            </View>
          );
        })}
        {page?.continuation.kind === 'more' ? (
          <Button
            label="More conversations"
            variant="ghost"
            onPress={() => {
              void session.nextInbox();
            }}
          />
        ) : null}
        {state.drafts.length ? (
          <View style={talkStyles.card}>
            <Text variant="ui">Drafts kept in this session</Text>
            <Text variant="bodyS">
              You can discard an inactive conversation’s draft. A request with an unknown result stays protected.
            </Text>
            {state.drafts.map((draft) => {
              const window = state.windows.find(
                (w) =>
                  w.conversation.conversationId.toLowerCase() === draft.conversation.conversationId.toLowerCase() &&
                  w.conversation.membershipId.toLowerCase() === draft.conversation.membershipId.toLowerCase() &&
                  w.conversation.membershipRevision === draft.conversation.membershipRevision,
              );
              return (
                <Button
                  key={draft.conversation.membershipId}
                  label={`Discard inactive draft${window?.peer ? ` with ${window.peer.displayName}` : ''}`}
                  variant="ghost"
                  disabled={state.mutationBlocked}
                  onPress={() => {
                    if (scope.active) session.forgetWindow(draft.conversation);
                  }}
                />
              );
            })}
          </View>
        ) : null}
        {state.command.status === 'pending' ? <Text variant="bodyS">Checking your change…</Text> : null}
        {state.command.status === 'unknown' ? (
          <View style={talkStyles.card}>
            <Text variant="bodyS">Your change wasn’t confirmed. Retry checks the same request.</Text>
            <Button
              label="Retry same request"
              onPress={() => {
                void session.retryCommand();
              }}
            />
          </View>
        ) : null}
        {state.command.status === 'rejected' || state.failure ? (
          <Text variant="bodyS">That action is unavailable. Refresh current status before choosing again.</Text>
        ) : null}
      </View>
    </ScreenFrame>
  );
}
export const talkStyles = StyleSheet.create({
  measure: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: spacing[4] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' },
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: 2,
    borderColor: content.ink,
    borderRadius: 18,
    backgroundColor: content.paper,
  },
  row: { gap: spacing[2], paddingVertical: spacing[4], borderBottomWidth: 1, borderColor: content.rule },
  input: {
    minHeight: 52,
    borderWidth: 2,
    borderColor: content.ink,
    borderRadius: 14,
    padding: spacing[3],
    fontSize: 18,
    color: content.ink,
    backgroundColor: content.paper,
    textAlignVertical: 'top',
  },
});
