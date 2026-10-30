import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TALK_QUERY_KEY,
  composerAddressees,
  findThread,
  type AccountScope,
  type ContentThreadController,
  type ContentThreadState,
} from '@knowscroll/client-core';
import type { ContentThreadRef, ReelDocument, SendThreadBody } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Banner, PullDownSheet, Skeleton, StateBlock, useDisplay, type ReelPositionHandle } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { TalkFrame } from '../shell/talk-frame';
import { Composer } from '../conversations/composer';
import { useFollowEnd } from '../conversations/message-list';
import { AsksBar } from '../scenarios/asks-bar';
import { BranchSheets } from '../scenarios/branch-sheets';
import { useScenarioBoard } from '../scenarios/use-scenarios';
import { useThreadBranches } from '../scenarios/use-thread-branches';
import { useOwnPlace } from './own-place';
import { useMarkHere } from '../scenarios/use-mark-here';
import { ShareMomentSheet } from './share-moment-sheet';
import { PartsSection, seriesHeading } from './series-sections';
import { InvitationView, OptionsSheet, ThreadPeople, ThreadStrip, threadEyebrow, threadTitle } from './thread-chrome';
import { ThreadEncounter } from './thread-encounter';
import { readInThreadHref, snippetHref, threadRefFromParams } from './thread-links';
import { ThreadMessages } from './thread-messages';
import { useContentThread } from './use-content-thread';

/** D03, T3: the series panel beside the conversation. */
const SERIES_PANEL_WIDTH = 400;

/** Until the header reports its own height (T3: 72 px on a thread). */
const HEADER_HEIGHT_GUESS = 72;

const draftKey = (threadId: string) => `thread.draft.${threadId}`;

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

interface ReadyThreadProps {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly controller: ContentThreadController;
  readonly state: ContentThreadState;
  readonly title: string;
  readonly onBack: () => void;
  readonly onLeft: () => void;
}

/**
 * What the person sees once the thread is read: a 72 px header, the thread's own part (a docked
 * player on a phone, a panel of parts and the player on a desktop), then the conversation, which
 * keeps the rest of the screen (T3, D-140).
 */
function ReadyThread({ scope, thread, controller, state, title, onBack, onLeft }: ReadyThreadProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // From 1024 px the panel and the conversation sit side by side (D03, T3); below it the player docks.
  const sideBySide = useDisplay().breakpoint === 'desktop';
  const place = useOwnPlace(scope, thread.threadId, !sideBySide);
  useMarkHere(scope, thread.threadId);
  const [draft, keepDraft] = useDraft(scope, thread.threadId);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(HEADER_HEIGHT_GUESS);
  const [menu, setMenu] = useState(false);
  const [moment, setMoment] = useState<ShareableMoment>();
  const board = useScenarioBoard(scope, thread);
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
  // Watching is the person's own choice to have the player open: a later resize does not dock it.
  const { setFolded } = place;
  const onReelOpened = useCallback(() => setFolded(false), [setFolded]);

  const episodes = state.episodes;
  const series = state.sequence === 'series';
  const current = episodes.find((episode) => episode.assetId === place.selected) ?? episodes[0];
  const ownPersonId = state.participants.find((participant) => participant.you)?.person.personId;
  const branches = useThreadBranches({
    scope,
    thread,
    title,
    state,
    board,
    selectedAssetId: place.selected,
    onBranchStarted: () => {
      follow();
      // The new card is below the fold: show it once the branches are read and laid out.
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 150);
    },
  });
  const rootSummary =
    state.root?.status === 'available' && state.root.target.assetId === current?.assetId
      ? state.root.metadata.summary
      : undefined;
  // The sheet exists only below 1024 px: a resize to desktop with it open must not leave the player paused.
  const sheetOpen = seriesOpen && !sideBySide;
  const showMap = branches.mapOffered
    ? () => {
        setSeriesOpen(false);
        branches.map.show();
      }
    : undefined;
  const parts =
    current === undefined ? null : (
      <PartsSection
        episodes={episodes}
        selected={current.assetId}
        series={series}
        heading={sideBySide ? seriesHeading(series, episodes.length) : undefined}
        onSelect={(assetId) => {
          place.select(assetId);
          setSeriesOpen(false);
        }}
        onStep={place.select}
        onMap={showMap}
      />
    );
  const encounter =
    current === undefined ? null : (
      <ThreadEncounter
        scope={scope}
        readHref={(assetId) => readInThreadHref(thread, assetId)}
        episode={current}
        series={series}
        total={episodes.length}
        folded={place.folded}
        onToggleFold={() => place.setFolded(!place.folded)}
        onShareMoment={setMoment}
        paused={moment !== undefined || sheetOpen || menu}
        positionRef={positionRef}
        onOpened={onReelOpened}
        summary={rootSummary}
        dock
      />
    );
  // One element path for both layouts: only styles differ, and the roles stay the same because React
  // Native Web draws a different element for each role, which would remount the player on a resize
  // across 1024 px (ending its recorder and opening a second exposure). The parts and the people sit
  // in fixed slots around the encounter for the same reason: the panel adds them, the phone does not.
  return (
    <>
      <ThreadStrip
        title={title}
        eyebrow={threadEyebrow(state, sideBySide)}
        onBack={onBack}
        series={
          sideBySide || current === undefined
            ? undefined
            : { open: seriesOpen, onPress: () => setSeriesOpen(!seriesOpen) }
        }
        onMenu={() => setMenu(true)}
        onLayout={(event: LayoutChangeEvent) => setHeaderHeight(event.nativeEvent.layout.height)}
      />
      {state.offline ? (
        <View style={styles.banner}>
          <Banner kind="reconnecting" lead="Reconnecting…" message="Missing messages will appear in order." />
        </View>
      ) : null}
      <View style={sideBySide ? styles.panes : styles.stack}>
        <View role="region" aria-label="Thread" style={sideBySide ? styles.panel : styles.fitContent}>
          <ScrollView
            scrollEnabled={sideBySide}
            style={sideBySide ? undefined : styles.fitContent}
            contentContainerStyle={sideBySide ? styles.panelContent : undefined}
          >
            {sideBySide ? parts : null}
            {encounter}
            {sideBySide ? <ThreadPeople participants={state.participants} /> : null}
          </ScrollView>
        </View>
        <View role="region" aria-label="Conversation" style={styles.stack}>
          <ThreadMessages
            state={state}
            controller={controller}
            ownPersonId={ownPersonId}
            episodes={episodes}
            scrollRef={scrollRef}
            onScroll={onScroll}
            onOpenSnippet={(messageId) => router.push(snippetHref(thread, messageId))}
            branches={board.state.cards}
            openedBranches={board.state.opened}
            onOpenBranch={branches.openBranch}
            onContinueBranch={branches.scenarios.continueBranch}
            onRemoveBranch={branches.scenarios.removeBranch}
            onMessageMenu={branches.scenarios.askFromMessage}
            onAsk={branches.scenarios.askFromMessage}
          />
          <AsksBar onAsk={branches.scenarios.askFromRoot} />
          <Composer
            name={composerAddressees(
              state.participants.filter((participant) => !participant.you).map((participant) => participant.person),
            )}
            value={draft}
            onChange={keepDraft}
            onSend={(text) => {
              keepDraft('');
              follow();
              void controller.send({ kind: 'text', text });
            }}
          />
        </View>
      </View>
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
      <PullDownSheet
        visible={sheetOpen}
        title={seriesHeading(series, episodes.length)}
        top={insets.top + headerHeight}
        onClose={() => setSeriesOpen(false)}
        testID="thread-series-sheet"
      >
        {parts}
        <ThreadPeople participants={state.participants} />
      </PullDownSheet>
      <BranchSheets
        scope={scope}
        thread={thread}
        scenarios={branches.scenarios}
        map={branches.map}
        suggestions={board.state.suggestions}
        navigate="push"
        onChosen={branches.scenarios.branchStarted}
        onOpenEpisode={place.select}
      />
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
        <ThreadStrip title={title} eyebrow={undefined} onBack={back} onMenu={undefined} />
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
    <TalkFrame>
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
    </TalkFrame>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  body: { padding: layout.gutter },
  banner: { paddingHorizontal: layout.gutter, paddingTop: spacing[2] },
  /** T3 desktop: the series panel on the right, the conversation filling the rest (the DOM order stays panel first). */
  panes: { flex: 1, minHeight: 0, flexDirection: 'row-reverse' },
  stack: { flex: 1, minHeight: 0 },
  /** One column: the thread's own part takes the height of its content and the messages take the rest. */
  fitContent: { flexGrow: 0, flexShrink: 0 },
  panel: {
    width: SERIES_PANEL_WIDTH,
    borderLeftWidth: borderWidth.regular,
    borderLeftColor: content.ink,
    minHeight: 0,
  },
  panelContent: { padding: layout.gutter, gap: spacing[4], paddingBottom: spacing[6] },
});
