import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  blockFriend,
  type AccountScope,
  type FeedbackTarget,
  type ThreadController,
  type ThreadState,
} from '@knowscroll/client-core';
import { DELETED_ACCOUNT_LABEL, type DirectConversationRef } from '@knowscroll/contracts';
import { layout, spacing } from '@knowscroll/design-tokens';
import { Banner, Skeleton, StateBlock } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { FeedbackSheet } from '../feedback/feedback-sheet';
import { Composer } from './composer';
import { ConversationMenu } from './conversation-menu';
import { MessageList, useFollowEnd } from './message-list';
import { ThreadHeader } from './thread-header';

const draftKey = (conversationId: string) => `talk.draft.${conversationId}`;

/** The unsent text of one conversation, kept in the account scope's storage so leaving and coming back keeps it. */
function useDraft(scope: AccountScope, conversationId: string) {
  const [draft, setDraft] = useState(() => scope.storage.get(draftKey(conversationId)) ?? '');
  const keepDraft = (text: string) => {
    setDraft(text);
    if (text === '') scope.storage.remove(draftKey(conversationId));
    else scope.storage.set(draftKey(conversationId), text);
  };
  return [draft, keepDraft] as const;
}

/** What the screen shows before there is a thread to read, or nothing when the thread is ready. */
function unreadyView(state: ThreadState, controller: ThreadController, leaveToTalk: () => void): ReactNode {
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
  return undefined;
}

/** Offline and ended notices above the messages. */
function ThreadNotices({
  state,
  name,
  accountDeleted,
}: {
  readonly state: ThreadState;
  readonly name: string;
  readonly accountDeleted: boolean;
}) {
  return (
    <>
      {state.offline ? (
        <View style={styles.banner}>
          <Banner kind="reconnecting" lead="Reconnecting…" message="Missing messages will appear in order." />
        </View>
      ) : null}
      {state.ended ? (
        <View style={styles.banner}>
          <Banner
            kind="accessEnded"
            lead={accountDeleted ? 'This account was deleted.' : `${name} left this conversation.`}
            message="You can read it, but you can’t send anything more."
          />
        </View>
      ) : null}
    </>
  );
}

interface ThreadMenuProps {
  readonly scope: AccountScope;
  readonly controller: ThreadController;
  readonly state: ThreadState;
  readonly name: string;
  readonly accountDeleted: boolean;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly leaveToTalk: () => void;
  readonly onReport: () => void;
}

/** Mute, leave, report and block, each leaving Talk when it ends the conversation. */
function ThreadMenu({
  scope,
  controller,
  state,
  name,
  accountDeleted,
  visible,
  onClose,
  leaveToTalk,
  onReport,
}: ThreadMenuProps) {
  return (
    <ConversationMenu
      visible={visible}
      name={name}
      muted={state.muted}
      ended={state.ended}
      canBlock={!accountDeleted}
      onClose={onClose}
      onMute={(muted) => void controller.mute(muted)}
      onReport={onReport}
      onLeave={() => {
        onClose();
        void controller.leave().then((left) => {
          if (left) leaveToTalk();
        });
      }}
      onBlock={() => {
        onClose();
        const peerId = state.peer?.personId;
        if (peerId === undefined) return;
        void blockFriend(scope, newCommandId, peerId).then((blocked) => {
          if (blocked) leaveToTalk();
          else void controller.refresh();
        });
      }}
    />
  );
}

export interface ThreadProps {
  readonly scope: AccountScope;
  readonly controller: ThreadController;
  readonly state: ThreadState;
  readonly reference: DirectConversationRef;
}

const reportedPerson = (person: { personId: string; displayName: string; handle: string }) => ({
  personId: person.personId,
  displayName: person.displayName,
  handle: person.handle,
});

/** One open conversation: header, notices, messages, composer and options. */
export function Thread({ scope, controller, state, reference }: ThreadProps) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [reporting, setReporting] = useState<FeedbackTarget>();
  const [draft, keepDraft] = useDraft(scope, reference.conversationId);
  const {
    ref: scrollRef,
    onScroll,
    follow,
  } = useFollowEnd(`${state.phase}:${String(state.messages.length)}:${String(state.outgoing.length)}`);
  const leaveToTalk = () => router.replace('/conversations');
  const name = state.peer?.displayName ?? 'this person';
  // Their account is gone: nobody to block, and the banner says what happened, not who left.
  const accountDeleted = state.peer?.displayName === DELETED_ACCOUNT_LABEL;
  useDocumentTitle(state.peer?.displayName ?? 'Conversation');

  const unready = unreadyView(state, controller, leaveToTalk);
  if (unready !== undefined) return unready;
  return (
    <>
      <ThreadHeader
        peer={state.peer}
        fallbackName={name}
        onBack={() => (router.canGoBack() ? router.back() : leaveToTalk())}
        onMenu={() => setMenu(true)}
      />
      <ThreadNotices state={state} name={name} accountDeleted={accountDeleted} />
      <MessageList
        state={state}
        controller={controller}
        name={name}
        scrollRef={scrollRef}
        onScroll={onScroll}
        onReport={(message) =>
          setReporting({ kind: 'message', messageId: message.messageId, author: reportedPerson(message.author) })
        }
      />
      {state.ended ? null : (
        <Composer
          name={name}
          value={draft}
          onChange={keepDraft}
          onSend={(text) => {
            keepDraft('');
            follow();
            void controller.send({ kind: 'text', text });
          }}
        />
      )}
      <ThreadMenu
        scope={scope}
        controller={controller}
        state={state}
        name={name}
        accountDeleted={accountDeleted}
        visible={menu}
        onClose={() => setMenu(false)}
        leaveToTalk={leaveToTalk}
        onReport={() => {
          if (state.peer !== undefined) setReporting({ kind: 'person', person: reportedPerson(state.peer) });
        }}
      />
      <FeedbackSheet target={reporting} onClose={() => setReporting(undefined)} />
    </>
  );
}

const styles = StyleSheet.create({
  body: { padding: layout.gutter },
  banner: {
    paddingHorizontal: layout.gutter,
    paddingTop: spacing[3],
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
});
