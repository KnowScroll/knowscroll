import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TALK_QUERY_KEY,
  findThread,
  type AccountScope,
  type ContentThreadController,
  type ContentThreadState,
} from '@knowscroll/client-core';
import type {
  ContentThreadRef,
  ReelDocument,
  ScenarioCard,
  ScenarioKind,
  SendThreadBody,
  ThreadMessage,
} from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, StateBlock, type ReelPositionHandle } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { Composer } from '../conversations/composer';
import { useFollowEnd } from '../conversations/message-list';
import { ScenarioSheet, type ScenarioStart } from '../scenarios/scenario-sheet';
import { useScenarioBoard } from '../scenarios/use-scenarios';
import { EpisodeNavigator } from './episode-navigator';
import { ShareMomentSheet } from './share-moment-sheet';
import { InvitationView, OptionsSheet, PeopleSheet, ThreadHeader, threadTitle } from './thread-chrome';
import { ThreadEncounter } from './thread-encounter';
import { readInThreadHref, snippetHref, threadRefFromParams } from './thread-links';
import { ThreadMessages } from './thread-messages';
import { useContentThread } from './use-content-thread';

const draftKey = (threadId: string) => `thread.draft.${threadId}`;
const selectedKey = (threadId: string) => `thread.selected.${threadId}`;
const foldedKey = (threadId: string) => `thread.folded.${threadId}`;

/** The unsent text of one thread, kept in the account scope's storage so leaving and coming back keeps it. */
function useDraft(scope: AccountScope, threadId: string) {
  const [draft, setDraft] = useState(() => scope.storage.get(draftKey(threadId)) ?? '');
  const keepDraft = (text: string) => {
    setDraft(text);
    if (text === '') scope.storage.remove(draftKey(threadId));
    else scope.storage.set(draftKey(threadId), text);
  };
  return [draft, keepDraft] as const;
}

/**
 * This person's own place in the thread: the episode selected and whether the player is folded. It
 * lives in the account scope's storage on this device. It is never sent, so no one else can learn it.
 */
function useOwnPlace(scope: AccountScope, threadId: string) {
  const [selected, setSelected] = useState(() => scope.storage.get(selectedKey(threadId)));
  const [folded, setFolded] = useState(() => scope.storage.get(foldedKey(threadId)) === '1');
  return {
    selected,
    select: (assetId: string) => {
      setSelected(assetId);
      scope.storage.set(selectedKey(threadId), assetId);
    },
    folded,
    setFolded: (next: boolean) => {
      setFolded(next);
      scope.storage.set(foldedKey(threadId), next ? '1' : '0');
    },
  };
}

type AvailableMessage = Extract<ThreadMessage, { status: 'available' }>;

/** What a message says, for the menu above it: its words, or what a snippet points at. */
function previewOf(message: AvailableMessage): string {
  if (message.body.kind === 'text') return message.body.text;
  const { snippet, note } = message.body;
  const points =
    snippet.kind === 'reel_range'
      ? 'A shared moment of the video'
      : snippet.kind === 'scroll_passage'
        ? `A shared passage${snippet.quote === undefined ? '' : `: “${snippet.quote}”`}`
        : 'A shared part of the article';
  return note === undefined ? points : `${points} · ${note}`;
}

/** What the person sees once the thread is read: episodes, encounter, messages, composer and sheets. */
function ReadyThread({
  scope,
  thread,
  controller,
  state,
  title,
  onBack,
  onLeft,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly controller: ContentThreadController;
  readonly state: ContentThreadState;
  readonly title: string;
  readonly onBack: () => void;
  readonly onLeft: () => void;
}) {
  const router = useRouter();
  const place = useOwnPlace(scope, thread.threadId);
  const [draft, keepDraft] = useDraft(scope, thread.threadId);
  const [people, setPeople] = useState(false);
  const [menu, setMenu] = useState(false);
  const [moment, setMoment] = useState<ShareableMoment>();
  const board = useScenarioBoard(scope, thread);
  const [start, setStart] = useState<ScenarioStart>();
  const positionRef = useRef<ReelPositionHandle>(null);
  const {
    ref: scrollRef,
    onScroll,
    follow,
  } = useFollowEnd(`${String(state.messages.length)}:${String(board.state.cards.length)}`);
  // The keyboard opening folds the player, and folding pauses it (C04).
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => place.setFolded(true));
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setFolded only writes this device's storage and state
  }, []);

  const episodes = state.episodes;
  const series = state.sequence === 'series';
  const current = episodes.find((episode) => episode.assetId === place.selected) ?? episodes[0];
  const ownPersonId = state.participants.find((participant) => participant.you)?.person.personId;
  const rootRevision = state.root?.target.assetRevision;
  const askFromRoot = (kind: ScenarioKind) =>
    rootRevision === undefined
      ? undefined
      : setStart({
          kind,
          origin: { kind: 'root' },
          fromLabel: 'the whole thread',
          parent: { kind: 'root', assetRevision: rootRevision },
        });
  /** From a message's menu (no kind yet: the sheet asks) or straight from a snippet card's What if…. */
  const askFromMessage = (message: AvailableMessage, kind?: ScenarioKind) => {
    if (rootRevision === undefined) return;
    setStart({
      ...(kind === undefined
        ? { quote: { authorName: message.author.displayName, preview: previewOf(message) } }
        : { kind }),
      origin: { kind: 'message', messageId: message.messageId },
      fromLabel:
        message.body.kind === 'snippet' ? 'a shared moment or passage' : `${message.author.displayName}’s message`,
      parent: { kind: 'root', assetRevision: rootRevision },
    });
  };
  const continueBranch = (card: ScenarioCard) =>
    setStart({
      kind: 'what_if',
      origin: { kind: 'root' },
      fromLabel: 'this branch',
      parent: { kind: 'node', nodeId: card.nodeId, revision: card.revision },
    });
  const openBranch = (card: ScenarioCard) => {
    if (card.content !== undefined) router.push(readInThreadHref(thread, card.content.assetId, { branch: true }));
  };
  const rootSummary =
    state.root?.status === 'available' && state.root.target.assetId === current?.assetId
      ? state.root.metadata.summary
      : undefined;
  return (
    <>
      <ThreadHeader
        title={title}
        people={state.participants.map((participant) => participant.person.displayName).join(', ')}
        onBack={onBack}
        onPeople={() => setPeople(true)}
        onMenu={() => setMenu(true)}
      />
      {state.offline ? (
        <View style={styles.banner}>
          <Banner kind="reconnecting" lead="Reconnecting…" message="Missing messages will appear in order." />
        </View>
      ) : null}
      {current === undefined ? null : (
        <View style={styles.column}>
          <EpisodeNavigator
            episodes={episodes}
            selected={current.assetId}
            series={series}
            folded={place.folded}
            onSelect={place.select}
          />
          <ThreadEncounter
            scope={scope}
            thread={thread}
            episode={current}
            series={series}
            total={episodes.length}
            folded={place.folded}
            onToggleFold={() => place.setFolded(!place.folded)}
            onShareMoment={setMoment}
            paused={moment !== undefined || people || menu}
            positionRef={positionRef}
            summary={rootSummary}
          />
        </View>
      )}
      <ThreadMessages
        state={state}
        controller={controller}
        ownPersonId={ownPersonId}
        episodes={episodes}
        scrollRef={scrollRef}
        onScroll={onScroll}
        onOpenSnippet={(messageId) => router.push(snippetHref(thread, messageId))}
        branches={board.state.cards}
        onOpenBranch={openBranch}
        onContinueBranch={continueBranch}
        onRemoveBranch={(card) => void board.controller.remove(card)}
        onMessageMenu={askFromMessage}
        onAsk={askFromMessage}
      />
      <View style={styles.asks} accessibilityLabel="Explore other possibilities">
        <Button
          label="What if…"
          size="sm"
          variant="ghost"
          icon="hypothetical"
          onPress={() => askFromRoot('what_if')}
          testID="ask-what-if"
        />
        <Button
          label="Another perspective"
          size="sm"
          variant="ghost"
          onPress={() => askFromRoot('perspective')}
          testID="ask-perspective"
        />
      </View>
      <Composer
        name={
          state.participants
            .filter((participant) => !participant.you)
            .map((participant) => participant.person.displayName.split(' ')[0])
            .join(' and ') || 'everyone'
        }
        value={draft}
        onChange={keepDraft}
        onSend={(text) => {
          keepDraft('');
          follow();
          void controller.send({ kind: 'text', text });
        }}
      />
      {moment === undefined ? null : (
        <ShareMomentSheet
          visible
          title={current?.title ?? ''}
          durationMs={moment.document.durationMs}
          positionMs={moment.positionMs}
          currentPositionMs={() => positionRef.current?.capture()?.positionMs ?? moment.positionMs}
          threadName={title}
          onClose={() => setMoment(undefined)}
          onShare={(range, note) => {
            setMoment(undefined);
            follow();
            void controller.send(momentMessage(moment.document, range, note));
          }}
        />
      )}
      <ScenarioSheet
        start={start}
        scope={scope}
        thread={thread}
        onClose={() => setStart(undefined)}
        onChosen={() => {
          follow();
          // The new card is below the fold: show it once the branches are read and laid out.
          void board.controller.load().then(() => {
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 150);
          });
        }}
      />
      <PeopleSheet visible={people} participants={state.participants} onClose={() => setPeople(false)} />
      <OptionsSheet
        visible={menu}
        onClose={() => setMenu(false)}
        onLeave={() => {
          setMenu(false);
          void controller.leave().then((left) => left && onLeft());
        }}
      />
    </>
  );
}

/** A Reel moment the person is about to share: the revision actually playing and where it was. */
interface ShareableMoment {
  readonly document: ReelDocument;
  readonly positionMs: number;
}

/** The snippet message for a chosen range of the exact Reel revision that is playing. */
function momentMessage(
  document: ReelDocument,
  range: { readonly startMs: number; readonly endMs: number },
  note: string,
): SendThreadBody {
  return {
    kind: 'snippet',
    target: { assetId: document.assetId, assetRevision: document.revision },
    anchor: { kind: 'reel_range', startMs: range.startMs, endMs: range.endMs },
    ...(note === '' ? {} : { note }),
  };
}

function OpenThread({ scope, thread }: { readonly scope: AccountScope; readonly thread: ContentThreadRef }) {
  const router = useRouter();
  const { controller, state } = useContentThread(scope, thread);
  const leaveToTalk = () => router.replace('/conversations');
  const back = () => (router.canGoBack() ? router.back() : leaveToTalk());
  const title = threadTitle(state);
  useDocumentTitle(title);

  // Coming back from a full-screen encounter or a reader: the person's own visited markers may have changed.
  const seen = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (seen.current) void controller.load();
      seen.current = true;
    }, [controller]),
  );

  if (state.phase === 'loading')
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading thread" />
      </View>
    );
  if (state.phase === 'unavailable')
    return (
      <StateBlock
        title="This thread isn’t available"
        body="It may have ended, or you may no longer have access."
        actions={[{ label: 'Back to Talk', role: 'link', href: '/conversations', onPress: leaveToTalk }]}
      />
    );
  if (state.phase === 'failed')
    return (
      <StateBlock
        title="Can’t open this thread"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    );
  if (state.phase === 'invitation')
    return (
      <>
        <ThreadHeader title={title} people={undefined} onBack={back} onPeople={undefined} onMenu={undefined} />
        <InvitationView
          state={state}
          onJoin={() => void controller.respond('join')}
          onDecline={() => void controller.respond('decline').then((answered) => answered && leaveToTalk())}
        />
      </>
    );
  return (
    <ReadyThread
      scope={scope}
      thread={thread}
      controller={controller}
      state={state}
      title={title}
      onBack={back}
      onLeft={leaveToTalk}
    />
  );
}

/** The reference to open: carried by the address, or found in the person's own thread list by ID. */
function ResolvedThread({
  scope,
  params,
}: {
  readonly scope: AccountScope;
  readonly params: { readonly threadId: string; readonly m?: string | undefined; readonly r?: string | undefined };
}) {
  const router = useRouter();
  const carried = threadRefFromParams(params);
  const lookup = useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'find-thread', params.threadId),
    enabled: carried === undefined,
    queryFn: async () => (await findThread(scope, newCommandId, params.threadId)) ?? null,
    staleTime: 60_000,
  });
  const thread = carried ?? lookup.data ?? undefined;
  if (thread !== undefined) return <OpenThread key={thread.threadId} scope={scope} thread={thread} />;
  if (lookup.isPending)
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading thread" />
      </View>
    );
  return (
    <StateBlock
      title="This thread isn’t available"
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
 * C04: one content thread. The episodes, the conversation and the encounter sit on one screen. What
 * is selected, folded or played is this person's own and stays on this device; the server holds the
 * messages, the people and what each person has opened themselves, and nothing about where anyone is.
 */
export function ThreadScreen(params: {
  readonly threadId: string;
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
      ) : state.status === 'unavailable' ? (
        <StateBlock
          title="Can’t reach your account"
          body="Reconnect to read this thread."
          actions={[{ label: 'Reconnect', onPress: () => void manager.refresh() }]}
        />
      ) : (
        <StateBlock
          title="Sign in to read this thread"
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
  /** The two ways to ask, between the messages and the message box. */
  asks: {
    flexDirection: 'row',
    gap: spacing[2],
    flexWrap: 'wrap',
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    backgroundColor: content.paper2,
  },
  /** The episodes and the encounter keep the reading measure, centred, on wide screens (the multi-pane layout is D03). */
  column: { width: '100%', maxWidth: layout.measureDesktop, alignSelf: 'center' },
});
