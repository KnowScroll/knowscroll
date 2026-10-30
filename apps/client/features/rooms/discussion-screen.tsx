import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createRoom,
  type AccountScope,
  type AskOutcome,
  type FeedbackTarget,
  type RoomDiscussionController,
  type RoomDiscussionState,
} from '@knowscroll/client-core';
import type { InhabitantId, ReelDocument, RoomMessage, SendRoomBody } from '@knowscroll/contracts';
import {
  BottomSheet,
  Banner,
  Button,
  Skeleton,
  StateBlock,
  Text,
  useDisplay,
  type ReelPositionHandle,
} from '@knowscroll/ui';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { afterPendingBack } from '../../platform/after-pending-back';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { Composer } from '../conversations/composer';
import { useFollowEnd } from '../conversations/message-list';
import { EpisodeNavigator } from '../threads/episode-navigator';
import { ShareMomentSheet } from '../threads/share-moment-sheet';
import { ThreadEncounter } from '../threads/thread-encounter';
import { ThreadHeader } from '../threads/thread-chrome';
import { InhabitantBar } from './inhabitant-bar';
import { FeedbackSheet } from '../feedback/feedback-sheet';
import { MessageOptionsSheet } from './message-options-sheet';
import { discussionHref, isRoomId, roomHref } from './room-links';
import { RoomMessages } from './room-messages';
import { RoomSnippetSheet } from './room-snippet-sheet';
import { useRoomDiscussion } from './use-room';

const draftKey = (discussionId: string) => `room.draft.${discussionId}`;
const selectedKey = (discussionId: string) => `room.selected.${discussionId}`;
const foldedKey = (discussionId: string) => `room.folded.${discussionId}`;

/** The unsent text of one discussion, kept in the account scope's storage so leaving and coming back keeps it. */
function useDraft(scope: AccountScope, discussionId: string) {
  const [draft, setDraft] = useState(() => scope.storage.get(draftKey(discussionId)) ?? '');
  const keepDraft = (text: string) => {
    setDraft(text);
    if (text === '') scope.storage.remove(draftKey(discussionId));
    else scope.storage.set(draftKey(discussionId), text);
  };
  return [draft, keepDraft] as const;
}

/**
 * This person's own place in the discussion's content: the episode selected and whether the player is
 * folded. It lives in the account scope's storage on this device and is never sent, so no one else
 * can learn it (blueprint §17: no peer position, no shared player).
 */
function useOwnPlace(scope: AccountScope, discussionId: string) {
  const [selected, setSelected] = useState(() => scope.storage.get(selectedKey(discussionId)));
  const [folded, setFolded] = useState(() => scope.storage.get(foldedKey(discussionId)) === '1');
  return {
    selected,
    select: (assetId: string) => {
      setSelected(assetId);
      scope.storage.set(selectedKey(discussionId), assetId);
    },
    folded,
    setFolded: (next: boolean) => {
      setFolded(next);
      scope.storage.set(foldedKey(discussionId), next ? '1' : '0');
    },
  };
}

/** A Reel moment the person is about to share: the revision actually playing and where it was. */
interface ShareableMoment {
  readonly document: ReelDocument;
  readonly positionMs: number;
}

function momentMessage(
  document: ReelDocument,
  range: { readonly startMs: number; readonly endMs: number },
  note: string,
): SendRoomBody {
  return {
    kind: 'snippet',
    target: { assetId: document.assetId, assetRevision: document.revision },
    anchor: { kind: 'reel_range', startMs: range.startMs, endMs: range.endMs },
    ...(note === '' ? {} : { note }),
  };
}

const ASK_WORDS: Record<Exclude<AskOutcome, 'asked'>, string> = {
  resting: 'AI inhabitants have answered enough for today. They’re back tomorrow.',
  unavailable: 'That isn’t available right now.',
  failed: 'Couldn’t ask just now. Try again in a moment.',
};

/** What the last ask came to, in words: from the server's record of an ask that ended without a reply, or this device's own attempt. */
function askWords(state: RoomDiscussionState, lastAsk: Exclude<AskOutcome, 'asked'> | undefined): string | undefined {
  if (lastAsk !== undefined) return ASK_WORDS[lastAsk];
  const unanswered = state.view?.yourAsk;
  if (unanswered === undefined) return undefined;
  const label = unanswered.inhabitant === 'explainer' ? 'AI · Explainer' : 'AI · Skeptic';
  return unanswered.outcome === 'nothing_to_add'
    ? `${label} had nothing to add.`
    : `${label} couldn’t answer this time.`;
}

function ModeratorSheet({
  visible,
  pinned,
  onPin,
  onClose,
}: {
  readonly visible: boolean;
  readonly pinned: boolean;
  readonly onPin: () => void;
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="Moderator actions for this discussion" onClose={onClose}>
      <View style={styles.sheet}>
        <Button label={pinned ? 'Unpin from the room' : 'Pin to the room'} variant="primary" onPress={onPin} />
        <Text variant="meta" color={content.ink2}>
          Pinning shows it at the top of the room. It doesn’t change anyone’s universe or position.
        </Text>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

/** What the person sees once the discussion is read: the content (if any), messages, the inhabitants and the composer. */
function ReadyDiscussion({
  scope,
  roomId,
  discussionId,
  controller,
  state,
  onBack,
  header,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly discussionId: string;
  readonly controller: RoomDiscussionController;
  readonly state: RoomDiscussionState;
  readonly onBack: () => void;
  /** What stands above the messages instead of the thread header (the room's own band for General); `null` for nothing. */
  readonly header: ReactNode | undefined;
}) {
  const router = useRouter();
  const { breakpoint } = useDisplay();
  const view = state.view!;
  const place = useOwnPlace(scope, discussionId);
  const [draft, keepDraft] = useDraft(scope, discussionId);
  const [moment, setMoment] = useState<ShareableMoment>();
  const [moderating, setModerating] = useState(false);
  const [options, setOptions] = useState<RoomMessage>();
  const [reporting, setReporting] = useState<FeedbackTarget>();
  const [snippet, setSnippet] = useState<string>();
  const [lastAsk, setLastAsk] = useState<Exclude<AskOutcome, 'asked'>>();
  const [roomController] = useState(() => createRoom({ scope, roomId, newId: newCommandId }));
  const positionRef = useRef<ReelPositionHandle>(null);
  const { ref: scrollRef, onScroll, follow } = useFollowEnd(String(state.messages.length));
  // The keyboard opening folds the player, and folding pauses it (C04).
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => place.setFolded(true));
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setFolded only writes this device's storage and state
  }, []);

  const rootContent = view.content;
  const episodes = rootContent?.episodes ?? [];
  const current = episodes.find((episode) => episode.assetId === place.selected) ?? episodes[0];
  const rootSummary =
    rootContent?.root.status === 'available' && rootContent.root.target.assetId === current?.assetId
      ? rootContent.root.metadata.summary
      : undefined;
  // A moderator pins a topic; General is where everyone lands and is never pinned.
  const moderator = view.role === 'moderator' && view.discussion.kind !== 'general';

  const ask = (inhabitant: InhabitantId) => {
    setLastAsk(undefined);
    void controller.ask(inhabitant).then((outcome) => setLastAsk(outcome === 'asked' ? undefined : outcome));
  };
  const startThread = (messageId: string) =>
    void roomController.startDiscussion({ kind: 'message', discussionId, messageId }).then((created) => {
      if (created !== undefined) afterPendingBack(() => router.push(discussionHref(roomId, created)));
    });

  return (
    <>
      {header !== undefined ? (
        header
      ) : (
        <ThreadHeader
          title={view.discussion.title}
          people={`in ${view.room.name}`}
          onBack={onBack}
          onMenu={moderator ? () => setModerating(true) : undefined}
        />
      )}
      {state.offline ? (
        <View style={styles.banner}>
          <Banner kind="reconnecting" lead="Reconnecting…" message="Missing messages will appear in order." />
        </View>
      ) : null}
      {!view.canPost ? (
        <View style={styles.banner}>
          <Banner
            kind="info"
            lead={view.room.status === 'closed' ? 'This room is closed.' : 'This room is paused.'}
            message="You can read earlier messages. New messages are off for now."
          />
        </View>
      ) : null}
      {rootContent === undefined || current === undefined ? null : (
        <View style={styles.column}>
          <EpisodeNavigator
            episodes={episodes}
            selected={current.assetId}
            series={rootContent.sequence.kind === 'series'}
            folded={place.folded}
            onSelect={place.select}
          />
          <ThreadEncounter
            scope={scope}
            readHref={(assetId) => `/scroll/${assetId}`}
            episode={current}
            series={rootContent.sequence.kind === 'series'}
            total={episodes.length}
            folded={place.folded}
            onToggleFold={() => place.setFolded(!place.folded)}
            onShareMoment={setMoment}
            paused={moment !== undefined || moderating || options !== undefined || snippet !== undefined}
            positionRef={positionRef}
            summary={rootSummary}
          />
        </View>
      )}
      <RoomMessages
        state={state}
        controller={controller}
        role={view.role}
        ownPersonId={view.you.personId}
        episodes={episodes}
        series={rootContent?.sequence.kind === 'series'}
        scrollRef={scrollRef}
        onScroll={onScroll}
        onOpenSnippet={setSnippet}
        onStartThread={startThread}
        onActions={setOptions}
      />
      {view.canPost ? (
        <>
          <InhabitantBar
            inhabitants={view.inhabitants}
            asking={state.asking}
            outcome={askWords(state, lastAsk)}
            onAsk={ask}
            compact={breakpoint === 'desktop'}
          />
          <Composer
            name={view.discussion.kind === 'general' ? 'General' : 'this discussion'}
            value={draft}
            onChange={keepDraft}
            onSend={(text) => {
              keepDraft('');
              follow();
              void controller.send({ kind: 'text', text });
            }}
          />
        </>
      ) : null}
      {moment === undefined ? null : (
        <ShareMomentSheet
          visible
          title={current?.title ?? ''}
          durationMs={moment.document.durationMs}
          positionMs={moment.positionMs}
          currentPositionMs={() => positionRef.current?.capture()?.positionMs ?? moment.positionMs}
          threadName={view.discussion.title}
          onClose={() => setMoment(undefined)}
          onShare={(range, note) => {
            setMoment(undefined);
            follow();
            void controller.send(momentMessage(moment.document, range, note));
          }}
        />
      )}
      <ModeratorSheet
        visible={moderating}
        pinned={view.discussion.pinned}
        onPin={() => {
          setModerating(false);
          void controller.pin(!view.discussion.pinned);
        }}
        onClose={() => setModerating(false)}
      />
      <MessageOptionsSheet
        message={options}
        role={view.role}
        ownPersonId={view.you.personId}
        onClose={() => setOptions(undefined)}
        onStartThread={startThread}
        onHide={(messageId, hidden) => void controller.hide(messageId, hidden)}
        onRemoveAuthor={(personId) => void controller.removeMember(personId).then(() => controller.refresh())}
        onReport={(message) =>
          setReporting({
            kind: 'room_message',
            messageId: message.messageId,
            // An AI inhabitant is a role, not a person: there is no one to block.
            ...(message.status === 'available' && message.author.kind === 'person'
              ? {
                  author: {
                    personId: message.author.personId,
                    displayName: message.author.displayName,
                    handle: message.author.handle,
                  },
                }
              : {}),
          })
        }
      />
      <FeedbackSheet target={reporting} onClose={() => setReporting(undefined)} />
      <RoomSnippetSheet
        scope={scope}
        roomId={roomId}
        discussionId={discussionId}
        messageId={snippet}
        onClose={() => setSnippet(undefined)}
      />
    </>
  );
}

/**
 * A discussion read and kept fresh: the messages, the composer and the person's own place in it. `header` replaces
 * the thread header when the room draws its own above it (General's campfire band).
 */
export function OpenDiscussion({
  scope,
  roomId,
  discussionId,
  header,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly discussionId: string;
  readonly header?: ReactNode;
}) {
  const router = useRouter();
  const { controller, state } = useRoomDiscussion(scope, roomId, discussionId);
  const backToRoom = () => (router.canGoBack() ? router.back() : router.replace(roomHref(roomId)));
  useDocumentTitle(state.view?.discussion.title ?? 'Discussion');

  // Coming back from a full-screen encounter, a reader or the Friends page: the person's own visited markers or
  // blocks may have changed, and neither reaches catch-up, so the whole discussion is read afresh.
  const seen = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (seen.current) void controller.resnapshot();
      seen.current = true;
    }, [controller]),
  );

  if (state.phase === 'loading')
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading discussion" />
      </View>
    );
  if (state.phase === 'unavailable' || state.view === undefined)
    return state.phase === 'failed' ? (
      <StateBlock
        title="Can’t open this discussion"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    ) : (
      <StateBlock
        title="This discussion isn’t available"
        body="It may have ended, or you may no longer be in this room."
        actions={[{ label: 'Back to the room', role: 'link', href: roomHref(roomId), onPress: backToRoom }]}
      />
    );
  return (
    <ReadyDiscussion
      scope={scope}
      roomId={roomId}
      discussionId={discussionId}
      controller={controller}
      state={state}
      onBack={backToRoom}
      header={header}
    />
  );
}

/**
 * R02: one discussion of a room. The same thread as a friend's (episodes, the encounter, messages,
 * snippets), with room membership instead of invitations. Messages are conversation, never evidence;
 * what is selected, folded or played is this person's own and stays on this device. AI inhabitants are
 * labelled, speak only when asked, and make nothing.
 */
export function RoomDiscussionScreen(params: { readonly roomId: string; readonly discussionId: string }) {
  const { state, manager } = useAccountScope();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {!isRoomId(params.roomId) || !isRoomId(params.discussionId) ? (
        <StateBlock title="This discussion isn’t available" body="Check the address and try again." />
      ) : state.status === 'signed_in' ? (
        <OpenDiscussion
          key={params.discussionId}
          scope={state.scope}
          roomId={params.roomId}
          discussionId={params.discussionId}
        />
      ) : state.status === 'unavailable' ? (
        <StateBlock
          title="Can’t reach your account"
          body="Reconnect to read this discussion."
          actions={[{ label: 'Reconnect', onPress: () => void manager.refresh() }]}
        />
      ) : (
        <StateBlock
          title="Sign in to read this discussion"
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  body: { padding: layout.gutter },
  banner: { paddingHorizontal: layout.gutter, paddingTop: spacing[2] },
  sheet: { gap: spacing[3] },
  /** The episodes and the encounter keep the reading measure, centred, on wide screens (the multi-pane layout is D04). */
  column: { width: '100%', maxWidth: layout.measureDesktop, alignSelf: 'center' },
});
