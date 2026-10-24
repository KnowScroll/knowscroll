import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { returnTarget, type AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioCard } from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Button, PendingStripe, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { afterPendingBack, notePendingBack } from '../../platform/after-pending-back';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { OpenScroll, ThreadScrollArticle } from '../threads/scroll-open';
import { useOwnPlace } from '../threads/own-place';
import { useMarkHere } from './use-mark-here';
import { threadHref, threadRefFromParams } from '../threads/thread-links';
import { threadTitle } from '../threads/thread-chrome';
import { useContentThread } from '../threads/use-content-thread';
import { BranchNavigator, SpeculativeBanner, TryAnotherPrompt, branchSubtitle } from './branch-chrome';
import { branchViewOf } from './branch-view';
import { BranchSheets } from './branch-sheets';
import { useScenarioBoard } from './use-scenarios';
import { useThreadBranches } from './use-thread-branches';

/** The branch itself, once its Scroll exists: the article, and a way to try another assumption from it. */
function ReadyBranch({
  scope,
  card,
  onAsk,
  onBack,
}: {
  readonly scope: AccountScope;
  readonly card: ScenarioCard & { readonly content: NonNullable<ScenarioCard['content']> };
  readonly onAsk: (words: string) => void;
  readonly onBack: () => void;
}) {
  const [prompting, setPrompting] = useState(true);
  return (
    <>
      <View style={styles.article}>
        <OpenScroll scope={scope} assetId={card.content.assetId} onBack={onBack}>
          {(scroll) => (
            <ThreadScrollArticle
              scope={scope}
              scroll={scroll}
              chrome="own"
              endSlot={
                prompting ? <TryAnotherPrompt onContinue={onAsk} onDismiss={() => setPrompting(false)} /> : undefined
              }
            />
          )}
        </OpenScroll>
      </View>
    </>
  );
}

/** What stands where the Scroll will be, once the branch is known to be there: being made, or unable to be. */
function BranchStatus({ view }: { readonly view: { readonly kind: 'preparing' | 'branch_failed' | 'removed' } }) {
  if (view.kind === 'removed')
    return <StateBlock title="This branch was removed" body="The rest of the thread is where you left it." />;
  if (view.kind === 'branch_failed')
    return (
      <StateBlock title="Couldn’t prepare this branch" body="It can be removed from the thread and asked for again." />
    );
  return (
    <View style={styles.preparing} role="status" accessibilityLabel="Preparing the first Scroll">
      <PendingStripe compact />
      <Text variant="uiS">Preparing the first Scroll</Text>
      <Text variant="meta" color={content.ink2}>
        This changes when it is ready. You can go back to the thread meanwhile.
      </Text>
    </View>
  );
}

/**
 * What a branch's address shows when there is no branch to show: still reading, not the member's thread, a read that
 * did not arrive, or no such branch among the ones they can see. Only a branch that is there and was removed says
 * "removed" (that is `BranchStatus`); everything else says only what is true of the read.
 */
function NoBranch({
  view,
  onRetry,
  onBack,
}: {
  readonly view: { readonly kind: 'loading' | 'thread_unavailable' | 'failed' | 'missing' };
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) {
  const router = useRouter();
  if (view.kind === 'loading')
    return (
      <View style={styles.state}>
        <Skeleton rows={3} label="Opening the branch" />
      </View>
    );
  if (view.kind === 'thread_unavailable')
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
  if (view.kind === 'failed')
    return (
      <StateBlock
        title="Can’t open this branch"
        body="It didn’t load. Check your connection and try again."
        actions={[
          { label: 'Try again', variant: 'primary', onPress: onRetry },
          { label: 'Back to the thread', onPress: onBack },
        ]}
      />
    );
  return (
    <StateBlock
      title="This branch isn’t available"
      body="It may not exist, or you may no longer have access."
      actions={[{ label: 'Back to the thread', onPress: onBack }]}
    />
  );
}

function BranchBody({
  scope,
  thread,
  nodeId,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly nodeId: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const board = useScenarioBoard(scope, thread);
  const { controller, state } = useContentThread(scope, thread);
  const place = useOwnPlace(scope, thread.threadId);
  useMarkHere(scope, thread.threadId, nodeId);
  const card = board.state.cards.find((candidate) => candidate.nodeId === nodeId);
  const view = branchViewOf(state.phase, board.state.phase, card);
  const title = threadTitle(state);
  const named = view.kind === 'preparing' || view.kind === 'branch_failed' || view.kind === 'ready';
  useDocumentTitle(named ? `${branchSubtitle(view.card)} · ${title}` : title);
  const back = returnTarget(title, state.episodes, place.selected);
  const branches = useThreadBranches({
    scope,
    thread,
    title,
    state,
    board,
    selectedAssetId: place.selected,
    onBranchStarted: () => undefined,
  });
  const toThread = () => {
    if (router.canGoBack()) router.back();
    else router.replace(threadHref(thread));
  };
  const retry = () => {
    void board.controller.load();
    void controller.refresh();
  };
  if (
    view.kind === 'loading' ||
    view.kind === 'thread_unavailable' ||
    view.kind === 'failed' ||
    view.kind === 'missing'
  )
    return (
      <View role="main" style={[styles.screen, { paddingTop: insets.top + spacing[3] }]}>
        <NoBranch view={view} onRetry={retry} onBack={toThread} />
      </View>
    );
  const item = view.kind === 'ready' ? 'current' : view.kind === 'preparing' ? 'preparing' : undefined;
  const speculative = named && view.card.speculative;
  return (
    <View role="main" style={[styles.screen, { paddingTop: insets.top + spacing[3] }]}>
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <Text variant="title" heading={1} numberOfLines={2} style={styles.grow}>
            {title}
          </Text>
          {branches.mapOffered ? <Button label="Map" size="sm" variant="ghost" onPress={branches.map.show} /> : null}
        </View>
        {named ? (
          <Text variant="uiS" color={content.accent} numberOfLines={2}>
            {branchSubtitle(view.card)}
          </Text>
        ) : null}
        <BranchNavigator returnLabel={back.label} returnSpoken={back.spoken} item={item} onReturn={toThread} />
        {speculative ? <SpeculativeBanner /> : null}
      </View>
      {view.kind === 'ready' ? (
        <ReadyBranch
          scope={scope}
          card={view.card}
          onAsk={(words) => branches.scenarios.continueBranch(view.card, words)}
          onBack={toThread}
        />
      ) : (
        <View style={styles.state}>
          <BranchStatus view={view} />
          <Button label={back.spoken} variant="ghost" onPress={toThread} />
        </View>
      )}
      <BranchSheets
        scope={scope}
        thread={thread}
        scenarios={branches.scenarios}
        map={branches.map}
        suggestions={board.state.suggestions}
        navigate="replace"
        onChosen={() => {
          // The sheet's own history entry goes first: leaving the branch before it has gone would pop that instead.
          notePendingBack();
          afterPendingBack(toThread);
        }}
        onOpenEpisode={(assetId) => {
          place.select(assetId);
          afterPendingBack(toThread);
        }}
      />
    </View>
  );
}

/**
 * X03: a branch opened from its card or from the map. The navigator is swapped for the branch's own item
 * with a way back that names where it goes; a speculative branch says so over its Scroll. What is read here
 * is an ordinary encounter of the member's own, and where they are in it is theirs on this device: nobody is
 * pulled along. Route `/threads/<id>/b/<node>`.
 */
export function BranchScreen(params: {
  readonly threadId: string;
  readonly nodeId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
}) {
  const { state } = useAccountScope();
  const router = useRouter();
  const thread = threadRefFromParams(params);
  if (state.status !== 'signed_in' || thread === undefined)
    return (
      <StateBlock
        title="This branch isn’t available here"
        body="Open it from the thread."
        actions={[
          { label: 'Back', onPress: () => (router.canGoBack() ? router.back() : router.replace('/conversations')) },
        ]}
      />
    );
  return <BranchBody scope={state.scope} thread={thread} nodeId={params.nodeId.toLowerCase()} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  /** The header keeps the reading measure, centred, on wide screens (the multi-pane layout is D03). */
  head: {
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[3],
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grow: { flex: 1 },
  article: { flex: 1 },
  state: {
    gap: spacing[4],
    padding: layout.gutter,
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  preparing: { gap: spacing[2] },
});
