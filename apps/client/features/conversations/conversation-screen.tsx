import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { FlatList, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import type { AccountScope, ConversationsState } from '@knowscroll/client-core';
import {
  ConversationTextSchema,
  type ConversationMessage as Message,
  type DirectConversationRef,
} from '@knowscroll/contracts';
import { Button, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { useFriendsSession } from '../friends/use-friends-session';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { ConversationMessage } from './conversation-message';
import { talkStyles } from './conversations-screen';
import { conversationOffset, retainConversationOffset, useConversationsSession } from './use-conversations-session';

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function currentRef(state: ConversationsState, id: string | undefined): DirectConversationRef | undefined {
  if (!id || state.status !== 'active') return undefined;
  // A fresh inbox supplies current participation independently of retained old memberships.
  const inbox =
    state.inbox.status === 'ready' && state.inbox.data.status === 'ready'
      ? state.inbox.data.items.find((i) => sameId(i.conversation.conversationId, id))?.conversation
      : undefined;
  if (inbox) return inbox;
  const windows = state.windows.filter((w) => sameId(w.conversation.conversationId, id)).reverse();
  return windows.find((w) => w.status !== 'unavailable')?.conversation ?? windows[0]?.conversation;
}
export function ConversationScreen({ conversationId }: { readonly conversationId: string | undefined }) {
  const { state } = useAccountScope();
  const router = useRouter();
  if (state.status !== 'signed_in')
    return (
      <ScreenFrame tone="paper" title="Talk" bodyOffset={24}>
        <Text variant="body">Sign in and choose a current conversation from Talk.</Text>
        <Button
          label="Back to Talk"
          role="link"
          href="/conversations"
          onPress={() => router.replace('/conversations')}
        />
      </ScreenFrame>
    );
  return <SignedInConversation scope={state.scope} conversationId={conversationId} />;
}
export function SignedInConversation({
  scope,
  conversationId,
}: {
  readonly scope: AccountScope;
  readonly conversationId: string | undefined;
}) {
  const { session, state } = useConversationsSession(scope);
  const friends = useFriendsSession(scope);
  const router = useRouter();
  const ref = currentRef(state, conversationId);
  const window = ref
    ? state.windows.find(
        (w) =>
          sameId(w.conversation.conversationId, ref.conversationId) &&
          sameId(w.conversation.membershipId, ref.membershipId) &&
          w.conversation.membershipRevision === ref.membershipRevision,
      )
    : undefined;
  const draft = ref
    ? state.drafts.find(
        (d) =>
          sameId(d.conversation.conversationId, ref.conversationId) &&
          sameId(d.conversation.membershipId, ref.membershipId) &&
          d.conversation.membershipRevision === ref.membershipRevision,
      )?.body
    : undefined;
  const [ownPersonId, setOwnPersonId] = useState<string>();
  const [visible, setVisible] = useState({ key: '', through: 0 });
  const visibleKey = ref
    ? `${ref.conversationId.toLowerCase()}:${ref.membershipId.toLowerCase()}:${ref.membershipRevision}`
    : '';
  const visibleThrough = visible.key === visibleKey ? visible.through : 0;
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const live = useRef(true);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    live.current = true;
    const off = scope.onEnd?.(() => {
      live.current = false;
      input.current?.clear();
      input.current = null;
      setOwnPersonId(undefined);
      setVisible({ key: '', through: 0 });
      setLeaveConfirm(false);
    });
    return () => {
      live.current = false;
      off?.();
    };
  }, [scope]);
  useEffect(() => {
    if (!friends) return;
    const update = () => {
      if (!scope.active || !live.current) return;
      const profile = friends.getState().profile;
      setOwnPersonId(
        profile.status === 'ready' && profile.data.status === 'claimed' ? profile.data.person.personId : undefined,
      );
    };
    const off = friends.subscribe(update);
    void friends.readProfile();
    return off;
  }, [friends, scope]);
  const membershipId = ref?.membershipId;
  const membershipRevision = ref?.membershipRevision;
  const inboxState = state.inbox;
  useFocusEffect(
    useCallback(() => {
      const snapshot = session.getState();
      // Loading is not fresh membership authority. Reopening a retained window here
      // would supersede the core's shared read serial and abort that inbox recheck.
      if (
        snapshot.inbox !== inboxState ||
        inboxState.status !== 'ready' ||
        inboxState.data.status !== 'ready' ||
        !conversationId
      )
        return;
      const current = inboxState.data.items.find((item) =>
        sameId(item.conversation.conversationId, conversationId),
      )?.conversation;
      if (
        scope.active &&
        current &&
        membershipId !== undefined &&
        sameId(current.membershipId, membershipId) &&
        current.membershipRevision === membershipRevision
      )
        void session.open(current);
    }, [scope, session, conversationId, membershipId, membershipRevision, inboxState]),
  );
  const onVisible = useCallback(
    ({ viewableItems }: { viewableItems: readonly { isViewable: boolean; item: Message }[] }) => {
      if (!live.current || !scope.active) return;
      setVisible({
        key: visibleKey,
        through: Math.max(0, ...viewableItems.filter((i) => i.isViewable).map((i) => i.item.sequence)),
      });
    },
    [scope, visibleKey, setVisible],
  );
  const openContent = (target: { assetId: string; assetRevision: number }) => {
    if (!scope.active || !live.current || !ref || window?.status !== 'ready') return;
    const destination = `/conversations/${ref.conversationId}`;
    // This callback captures only a route locator, never a message/body/card projection.
    if (
      encounterSessionFor(scope).openConversationContent(target, () => {
        if (scope.active) {
          if (router.canGoBack()) router.back();
          else router.replace(destination);
        }
      })
    ) {
      if (!scope.active || !live.current) return;
      router.push('/explore');
    }
  };
  const ready = scope.active && state.status === 'active' && window?.status === 'ready';
  const locked = !ready || state.mutationBlocked;
  const submit = () => {
    if (!ref || locked || !draft || !live.current) return;
    if (draft.kind === 'text') session.setDraft(ref, { kind: 'text', text: draft.text.trim() });
    else
      session.setDraft(ref, {
        kind: 'content',
        target: draft.target,
        ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
      });
    void session.send(ref);
  };
  return (
    <ScreenFrame tone="paper" title="Talk" pageTitle="Conversation" bodyOffset={16}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={talkStyles.measure}>
        <Button label="Back to Talk" role="link" href="/conversations" variant="ghost" onPress={() => router.back()} />
        {!ref ? (
          <View style={talkStyles.card}>
            <Text variant="title">Choose a current conversation</Text>
            <Text variant="body">
              Open a conversation from Talk. This address alone doesn’t establish current participation.
            </Text>
            <Button
              label="Choose from Talk"
              role="link"
              href="/conversations"
              onPress={() => router.replace('/conversations')}
            />
          </View>
        ) : (
          <>
            <Text variant="title" heading={2}>
              {ready && window.peer ? window.peer.displayName : 'Conversation'}
            </Text>
            <View style={talkStyles.actions}>
              <Button
                label="Refresh conversation"
                variant="ghost"
                disabled={window?.status === 'loading'}
                onPress={() => {
                  setVisible({ key: '', through: 0 });
                  void session.refreshConversation(ref);
                }}
              />
              {ready && window.own ? (
                <Button
                  label={window.own.muted ? 'Unmute notifications' : 'Mute notifications'}
                  variant="ghost"
                  disabled={locked}
                  onPress={() => {
                    void session.mute(ref, !window.own!.muted);
                  }}
                />
              ) : null}
              {ready ? (
                <Button
                  label="Leave conversation"
                  variant="ghost"
                  disabled={locked}
                  onPress={() => setLeaveConfirm(true)}
                />
              ) : null}
              {ready ? (
                <Button
                  label="Manage friend or block"
                  role="link"
                  href="/friends"
                  variant="ghost"
                  onPress={() => router.push('/friends')}
                />
              ) : null}
            </View>
            {leaveConfirm && ready ? (
              <View style={talkStyles.card}>
                <Text variant="body">
                  Leave this conversation? You won’t be able to send or open its shared items. Starting again is a new
                  deliberate choice.
                </Text>
                <Button
                  label="Confirm leave"
                  variant="danger"
                  disabled={locked}
                  onPress={() => {
                    setLeaveConfirm(false);
                    void session.leave(ref);
                  }}
                />
                <Button label="Stay in conversation" variant="ghost" onPress={() => setLeaveConfirm(false)} />
              </View>
            ) : null}
            {window?.status === 'loading' ? <Text variant="bodyS">Checking current conversation…</Text> : null}
            {window?.status === 'unavailable' ? (
              <View style={talkStyles.card}>
                <Text variant="body">This conversation is unavailable. Refresh to check current access.</Text>
                <Text variant="bodyS">
                  Messages and shared items aren’t shown while participation can’t be checked. Nothing sends
                  automatically.
                </Text>
              </View>
            ) : window?.status === 'refresh_required' ? (
              <Text variant="bodyS">Refresh this conversation to read current messages.</Text>
            ) : null}
            {ready ? (
              <>
                {window.historyAvailable ? (
                  <Button
                    label="Load earlier messages"
                    variant="ghost"
                    onPress={() => {
                      void session.history(ref);
                    }}
                  />
                ) : null}
                {!window.messages.length ? <Text variant="body">No messages yet.</Text> : null}
                <FlatList<Message>
                  key={visibleKey}
                  testID="conversation-messages"
                  style={{ maxHeight: 440, minHeight: window.messages.length ? 180 : 0 }}
                  data={window.messages}
                  keyExtractor={(message) => message.messageId}
                  renderItem={({ item }) => (
                    <ConversationMessage
                      message={item}
                      own={item.status === 'available' && !!ownPersonId && sameId(item.author.personId, ownPersonId)}
                      onOpen={openContent}
                    />
                  )}
                  contentOffset={{
                    x: 0,
                    y: conversationOffset(
                      scope,
                      `${ref.conversationId.toLowerCase()}:${ref.membershipId.toLowerCase()}:${ref.membershipRevision}`,
                    ),
                  }}
                  onScroll={(event) =>
                    retainConversationOffset(
                      scope,
                      `${ref.conversationId.toLowerCase()}:${ref.membershipId.toLowerCase()}:${ref.membershipRevision}`,
                      event.nativeEvent.contentOffset.y,
                    )
                  }
                  scrollEventThrottle={32}
                  nestedScrollEnabled
                  maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                  onViewableItemsChanged={onVisible}
                  viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
                  accessibilityLabel="Conversation messages"
                />
                <View style={talkStyles.actions}>
                  <Button
                    label={window.catchUp === 'more' ? 'Load next change page' : 'Check for new messages'}
                    variant="ghost"
                    onPress={() => {
                      void session.catchUp(ref);
                    }}
                  />
                  <Button
                    label="Mark visible messages read"
                    variant="ghost"
                    disabled={
                      locked || visibleThrough === 0 || visibleThrough <= (window.own?.readThroughSequence ?? 0)
                    }
                    onPress={() => {
                      if (visibleThrough <= window.latestMessageSequence) void session.markRead(ref, visibleThrough);
                    }}
                  />
                </View>
                {window.catchUp === 'more' ? (
                  <Text variant="bodyS">More changes remain. Load the next page to continue.</Text>
                ) : window.catchUp === 'refresh_required' ? (
                  <Text variant="bodyS">Refresh conversation before continuing.</Text>
                ) : null}
                <View style={talkStyles.card}>
                  <Text variant="ui">
                    {draft?.kind === 'content'
                      ? 'Shared content · optional note'
                      : `Message ${window.peer?.displayName ?? 'this conversation'}`}
                  </Text>
                  {draft?.kind === 'content' ? (
                    <Button
                      label="Remove selected content"
                      variant="ghost"
                      disabled={locked}
                      onPress={() => session.setDraft(ref, undefined)}
                    />
                  ) : null}
                  <TextInput
                    ref={input}
                    accessibilityLabel={draft?.kind === 'content' ? 'Optional note' : 'Message text'}
                    placeholder={draft?.kind === 'content' ? 'Add a note' : 'Write a message'}
                    style={talkStyles.input}
                    multiline
                    maxLength={2000}
                    editable={!locked}
                    value={draft?.kind === 'text' ? draft.text : (draft?.note ?? '')}
                    onChangeText={(text) => {
                      if (!locked && live.current)
                        session.setDraft(
                          ref,
                          draft?.kind === 'content'
                            ? { kind: 'content', target: draft.target, ...(text ? { note: text } : {}) }
                            : text
                              ? { kind: 'text', text }
                              : undefined,
                        );
                    }}
                    onKeyPress={(event) => {
                      const shift = 'shiftKey' in event.nativeEvent && event.nativeEvent.shiftKey;
                      if (Platform.OS === 'web' && event.nativeEvent.key === 'Enter' && !shift) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                  />
                  <Button
                    label="Send"
                    disabled={
                      locked ||
                      !draft ||
                      (draft.kind === 'text'
                        ? !ConversationTextSchema.safeParse(draft.text.trim()).success
                        : !!draft.note?.trim() && !ConversationTextSchema.safeParse(draft.note.trim()).success)
                    }
                    onPress={submit}
                  />
                  <Text variant="bodyS">
                    Drafts stay only in this signed-in session. Offline messages don’t send automatically.
                  </Text>
                </View>
              </>
            ) : null}
            <View accessibilityLiveRegion="polite">
              {state.command.status === 'accepted' && state.command.operation === 'send' ? (
                <Text variant="bodyS">Send accepted. Refresh to read the current message.</Text>
              ) : null}
              {state.command.status === 'pending' ? <Text variant="bodyS">Checking your change…</Text> : null}
              {state.command.status === 'unknown' ? (
                <View style={talkStyles.card}>
                  <Text variant="bodyS">
                    We couldn’t confirm this request. It may have been accepted. Retrying uses the same request.
                  </Text>
                  <Button
                    label="Retry same request"
                    onPress={() => {
                      void session.retryCommand();
                    }}
                  />
                  {state.command.operation === 'send' || state.command.operation === 'message.send' ? (
                    <Button
                      label="Check prior send"
                      variant="ghost"
                      onPress={() => {
                        void session.recoverOwnSend(ref);
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
              {state.recovery.status === 'ready' ? (
                <Text variant="bodyS">
                  {state.recovery.data.status === 'accepted'
                    ? 'Your prior send was accepted. Refresh to read the current message.'
                    : 'The prior send is unavailable. That does not mean it wasn’t sent.'}
                </Text>
              ) : null}
              {state.command.status === 'rejected' || state.failure ? (
                <Text variant="bodyS">
                  This action couldn’t be completed. Refresh current status before choosing again.
                </Text>
              ) : null}
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </ScreenFrame>
  );
}
