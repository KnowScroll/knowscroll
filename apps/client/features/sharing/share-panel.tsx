import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Platform, ScrollView, Share, TextInput, View } from 'react-native';
import type { AccountScope, ConversationsState } from '@knowscroll/client-core';
import type { DirectConversationRef } from '@knowscroll/contracts';
import { Button, Text } from '@knowscroll/ui';
import { content, spacing } from '@knowscroll/design-tokens';
import { useAccountScope } from '../../providers/account-scope';
import { appApiOrigin } from '../../platform/api';
import { talkStyles } from '../conversations/conversations-screen';
import { useConversationsSession } from '../conversations/use-conversations-session';
import { PrivateShareScreen } from './private-share-screen';
import { useShareSession } from './use-share-session';

type Target = { assetId: string; assetRevision: number };
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameRef = (a: DirectConversationRef, b: DirectConversationRef) =>
  sameId(a.conversationId, b.conversationId) &&
  sameId(a.membershipId, b.membershipId) &&
  a.membershipRevision === b.membershipRevision;
function readable(state: ConversationsState, ref: DirectConversationRef) {
  return (
    state.status === 'active' &&
    state.inbox.status === 'ready' &&
    state.inbox.data.status === 'ready' &&
    state.inbox.data.items.some((item) => sameRef(item.conversation, ref)) &&
    state.windows.some((window) => window.status === 'ready' && sameRef(window.conversation, ref))
  );
}
export function SharePanel({
  target,
  title,
  onClose,
}: {
  readonly target: Target;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const { state } = useAccountScope();
  if (state.status !== 'signed_in')
    return (
      <View style={talkStyles.card}>
        <Text variant="body">Sign in to share this encounter.</Text>
        <Button label="Close share" onPress={onClose} />
      </View>
    );
  return (
    <SignedInSharePanel
      key={`${target.assetId}:${target.assetRevision}`}
      scope={state.scope}
      target={target}
      title={title}
      onClose={onClose}
    />
  );
}
export function SignedInSharePanel({
  scope,
  target,
  title,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly target: Target;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const { session: conversations, state: talk } = useConversationsSession(scope);
  const { session: shares, state } = useShareSession(scope);
  const [selected, setSelected] = useState<DirectConversationRef>();
  const [selectedSnapshot, setSelectedSnapshot] = useState<DirectConversationRef>();
  const selection = useRef<DirectConversationRef | undefined>(undefined);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const [privateCheck, setPrivateCheck] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const live = useRef(true);
  const generation = useRef(0);
  const router = useRouter();
  useEffect(() => {
    live.current = true;
    const stop = () => {
      live.current = false;
      generation.current++;
    };
    void conversations.refreshInbox();
    const off = scope.onEnd?.(() => {
      stop();
      input.current?.clear();
      input.current = null;
      selection.current = undefined;
      setSelected(undefined);
      setSelectedSnapshot(undefined);
      setNote('');
      setNotice('');
      setPrivateCheck(false);
      setConfirmRevoke(false);
    });
    return () => {
      stop();
      input.current?.clear();
      off?.();
    };
  }, [conversations, scope]);
  const current = () => live.current && scope.active && state.status === 'active';
  const blocked = !scope.active || talk.mutationBlocked || state.mutationBlocked;
  const inbox = talk.inbox.status === 'ready' && talk.inbox.data.status === 'ready' ? talk.inbox.data : undefined;
  // No old share projection from another encounter becomes this panel's link authority.
  const own =
    state.own.status === 'ready' &&
    state.own.data.status === 'available' &&
    sameId(state.own.data.target.assetId, target.assetId) &&
    state.own.data.target.assetRevision === target.assetRevision
      ? state.own.data
      : undefined;
  const selectedReady =
    !!selected && !!selectedSnapshot && sameRef(selected, selectedSnapshot) && readable(talk, selected);
  const select = async (ref: DirectConversationRef) => {
    if (!current() || blocked) return;
    const mine = ++generation.current;
    selection.current = ref;
    setSelected(ref);
    setSelectedSnapshot(undefined);
    setNotice('Checking current conversation…');
    await conversations.open(ref);
    if (!current() || mine !== generation.current || !selection.current || !sameRef(selection.current, ref)) return;
    if (!readable(conversations.getState(), ref)) {
      setNotice('This conversation couldn’t be checked. Choose a current destination again.');
      return;
    }
    setSelectedSnapshot(ref);
    setNotice('');
  };
  const clearSelection = () => {
    generation.current++;
    selection.current = undefined;
    setSelected(undefined);
    setSelectedSnapshot(undefined);
    setNotice('');
  };
  const send = async () => {
    if (
      !current() ||
      blocked ||
      !selected ||
      !selectedReady ||
      !selection.current ||
      !sameRef(selection.current, selected) ||
      !readable(conversations.getState(), selected) ||
      conversations.getState().mutationBlocked ||
      shares.getState().mutationBlocked
    )
      return;
    const mine = generation.current;
    setNotice('');
    const body = { kind: 'content' as const, target, ...(note.trim() ? { note: note.trim() } : {}) };
    const before = conversations.getState().command;
    conversations.setDraft(selected, body);
    if (!current() || mine !== generation.current) return;
    const admitted = conversations.getState().drafts.find((d) => sameRef(d.conversation, selected))?.body;
    if (
      !admitted ||
      admitted.kind !== 'content' ||
      !sameId(admitted.target.assetId, body.target.assetId) ||
      admitted.target.assetRevision !== body.target.assetRevision ||
      admitted.note !== body.note
    ) {
      setNotice('This share draft couldn’t be prepared. Check current conversation status before trying again.');
      return;
    }
    await conversations.send(selected);
    if (!current() || mine !== generation.current) return;
    const command = conversations.getState().command;
    if (
      command.status === 'accepted' &&
      command.operation === 'send' &&
      (!('commandId' in before) || !sameId(before.commandId, command.commandId))
    )
      setNotice('Message accepted. Open the conversation to read its current state.');
  };
  const create = async (audience: 'public' | 'private') => {
    if (!current() || blocked || (audience === 'private' && !selected)) return;
    const mine = generation.current;
    setNotice('');
    await shares.create({
      target,
      audience:
        audience === 'private' && selected
          ? { kind: 'conversation', conversation: selected }
          : { kind: 'public_metadata' },
    });
    if (!current() || mine !== generation.current) return;
    const command = shares.getState().command;
    if (command.status === 'accepted' && command.operation === 'create')
      await shares.readOwn({ kind: 'command', commandId: command.commandId });
  };
  const copy = async (system: boolean) => {
    if (!current() || !own || own.state !== 'active' || !state.tokenAvailable) return;
    const origin = appApiOrigin();
    if (!origin.ok) {
      setNotice('This link can’t be copied from this build.');
      return;
    }
    const mine = generation.current;
    // Recheck current own state before consuming the one-time token. No stale ACK grants access.
    await shares.readOwn({ kind: 'share', shareId: own.shareId });
    if (!current() || mine !== generation.current) return;
    const fresh = shares.getState().own;
    if (
      fresh.status !== 'ready' ||
      fresh.data.status !== 'available' ||
      !sameId(fresh.data.shareId, own.shareId) ||
      fresh.data.state !== 'active'
    ) {
      setNotice('This link is no longer available.');
      return;
    }
    const token = shares.takeToken();
    if (!token) {
      setNotice('Link delivery is unavailable. Revoke this link before creating a new one.');
      return;
    }
    try {
      // Dedicated /s token URL exception; only the deliberately requested external copy receives it.
      const url = `${origin.baseUrl}/s/${token}`;
      if (system && Platform.OS !== 'web') await Share.share({ message: url });
      else await Clipboard.setStringAsync(url);
      if (current() && mine === generation.current)
        setNotice(
          system && Platform.OS !== 'web'
            ? 'System sharing opened. Delivery isn’t confirmed.'
            : 'Link copied. External copies can’t be recalled.',
        );
    } catch {
      if (current() && mine === generation.current)
        setNotice('Link delivery wasn’t completed. Revoke this link before creating a new one.');
    }
  };
  if (!scope.active || state.status !== 'active')
    return (
      <View style={talkStyles.card}>
        <Text variant="body">This signed-in session ended.</Text>
      </View>
    );
  if (privateCheck) return <PrivateShareScreen scope={scope} onClose={() => setPrivateCheck(false)} />;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: spacing[4],
        paddingBottom: spacing[8],
        gap: spacing[3],
        backgroundColor: content.paper,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
      }}
    >
      <Text variant="title" heading={2}>
        Share
      </Text>
      <Text variant="ui">{title}</Text>
      <Text variant="bodyS">
        Send this exact version to a conversation or create a link. Receiving it doesn’t count as watching or reading.
      </Text>
      <Text variant="ui">Send to a conversation</Text>
      {talk.inbox.status === 'loading' ? <Text variant="bodyS">Loading conversations…</Text> : null}
      {talk.inbox.status === 'unavailable' ||
      (talk.inbox.status === 'ready' && talk.inbox.data.status === 'refresh_required') ? (
        <Text variant="bodyS">Refresh conversations before choosing a destination.</Text>
      ) : null}
      {inbox?.items.map((item) => (
        <Button
          key={item.conversation.conversationId}
          label={item.peer.displayName}
          variant="ghost"
          toggled={!!selected && sameRef(selected, item.conversation)}
          disabled={blocked}
          onPress={() => {
            void select(item.conversation);
          }}
        />
      ))}
      {inbox?.items.length === 0 ? (
        <Text variant="bodyS">
          {inbox.continuation.kind === 'more'
            ? 'No destinations in this part of the list.'
            : 'No current conversations. Start one in Talk.'}
        </Text>
      ) : null}
      <View style={talkStyles.actions}>
        <Button
          label="Refresh destinations"
          variant="ghost"
          onPress={() => {
            clearSelection();
            void conversations.refreshInbox();
          }}
        />
        {inbox?.continuation.kind === 'more' ? (
          <Button
            label="More destinations"
            variant="ghost"
            onPress={() => {
              clearSelection();
              void conversations.nextInbox();
            }}
          />
        ) : null}
      </View>
      <TextInput
        ref={input}
        accessibilityLabel="Optional share note"
        style={talkStyles.input}
        multiline
        maxLength={2000}
        editable={!blocked}
        value={note}
        onChangeText={(text) => {
          if (current() && !blocked) setNote(text);
        }}
        placeholder="Add a note (optional)"
      />
      <Button
        label="Send to selected conversation"
        disabled={blocked || !selectedReady}
        onPress={() => {
          void send();
        }}
      />
      {selected && notice.startsWith('Message accepted') ? (
        <Button
          label="Open conversation"
          onPress={() => {
            const href = `/conversations/${selected.conversationId}`;
            if (!current()) return;
            onClose();
            if (!scope.active) return;
            router.push(href);
          }}
        />
      ) : null}
      <Text variant="ui">Copy link / share elsewhere</Text>
      <Text variant="bodyS">
        A public link shows only public content information. A private link still requires current participation in the
        selected conversation.
      </Text>
      {!own ? (
        <View style={talkStyles.actions}>
          <Button
            label="Create public link"
            disabled={blocked}
            onPress={() => {
              void create('public');
            }}
          />
          <Button
            label="Create private conversation link"
            disabled={blocked || !selected}
            onPress={() => {
              void create('private');
            }}
          />
        </View>
      ) : (
        <View style={talkStyles.card}>
          <Text variant="bodyS">
            {own.audience.kind === 'public_metadata' ? 'Public metadata link' : 'Private conversation link'}
          </Text>
          <Text variant="bodyS">
            {own.state === 'active' ? 'Link active' : own.state === 'revoked' ? 'Link revoked' : 'Link expired'}
          </Text>
          {own.state === 'active' && state.tokenAvailable ? (
            <View style={talkStyles.actions}>
              <Button
                label="Copy link once"
                onPress={() => {
                  void copy(false);
                }}
              />
              {Platform.OS !== 'web' ? (
                <Button
                  label="Share link once"
                  onPress={() => {
                    void copy(true);
                  }}
                />
              ) : null}
            </View>
          ) : null}
          {own.state === 'active' && !state.tokenAvailable ? (
            <Text variant="bodyS">
              The link isn’t stored here. To get a new link, revoke this one and deliberately create another.
            </Text>
          ) : null}
          <Button
            label="Check link status"
            variant="ghost"
            onPress={() => {
              void shares.readOwn({ kind: 'share', shareId: own.shareId });
            }}
          />
          {own.state === 'active' ? (
            <Button label="Revoke link" variant="ghost" disabled={blocked} onPress={() => setConfirmRevoke(true)} />
          ) : (
            <Button
              label="Create a new public link"
              disabled={blocked}
              onPress={() => {
                void create('public');
              }}
            />
          )}
          {confirmRevoke ? (
            <>
              <Text variant="bodyS">Revoke this link? It will no longer open. External copies can’t be removed.</Text>
              <Button
                label="Confirm revoke link"
                variant="danger"
                disabled={blocked}
                onPress={() => {
                  setConfirmRevoke(false);
                  void shares.revoke(own.shareId).then(() => {
                    if (scope.active && live.current) void shares.readOwn({ kind: 'share', shareId: own.shareId });
                  });
                }}
              />
              <Button label="Keep link active" variant="ghost" onPress={() => setConfirmRevoke(false)} />
            </>
          ) : null}
        </View>
      )}
      {state.command.status === 'unknown' ? (
        <View style={talkStyles.card}>
          <Text variant="bodyS">
            The link request wasn’t confirmed. Retry uses the same request. A lost first delivery cannot be recovered as
            a new token.
          </Text>
          <Button
            label="Retry same link request"
            onPress={() => {
              void shares.retryCommand().then(() => {
                const command = shares.getState().command;
                if (live.current && scope.active && command.status === 'accepted')
                  void shares.readOwn({ kind: 'command', commandId: command.commandId });
              });
            }}
          />
        </View>
      ) : null}
      {talk.command.status === 'unknown' ? (
        <View style={talkStyles.card}>
          <Text variant="bodyS">The send wasn’t confirmed. It may have been accepted. No automatic resend occurs.</Text>
          <Button
            label="Retry same send"
            onPress={() => {
              void conversations.retryCommand();
            }}
          />
          {selected ? (
            <Button
              label="Check prior send"
              variant="ghost"
              onPress={() => {
                void conversations.recoverOwnSend(selected);
              }}
            />
          ) : null}
        </View>
      ) : null}
      {state.command.status === 'pending' ? <Text variant="bodyS">Checking your link request…</Text> : null}
      {state.command.status === 'rejected' || state.failure ? (
        <Text variant="bodyS">This link action is unavailable. Check current status before choosing again.</Text>
      ) : null}
      <View accessibilityLiveRegion="polite">{notice ? <Text variant="bodyS">{notice}</Text> : null}</View>
      <Button
        label="Check a private share code"
        variant="ghost"
        disabled={blocked}
        onPress={() => setPrivateCheck(true)}
      />
      <Text variant="bodyS">
        Content threads, moments and reports aren’t available in this conversation surface yet.
      </Text>
      <Button label="Close share" variant="ghost" onPress={onClose} />
    </ScrollView>
  );
}
