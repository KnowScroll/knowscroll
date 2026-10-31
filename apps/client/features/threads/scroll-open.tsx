import { useIsFocused, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createScopedBlockStateStore, type AccountScope, type ScrollBlockStateStore } from '@knowscroll/client-core';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Button, ErrorState, IconButton, OfflineState, ScrollArticle, Skeleton, StateBlock } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { recorderFor } from '../scroll/reading-recorder';
import type { OpenedScroll, OpenedStageScroll } from '../scroll/scroll-session';
import { StageReaderSurface } from '../scroll/stage-reader-surface';
import { useScrollSession } from '../scroll/use-scroll-session';

/** One quiet screen for every state that is not the article itself. */
function Frame({ children, onBack }: { readonly children: ReactNode; readonly onBack: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View role="main" style={[styles.ground, { paddingTop: insets.top + spacing[3] }]}>
      <IconButton icon="back" label="Back to thread" onPress={onBack} />
      <View style={styles.state}>{children}</View>
    </View>
  );
}

/**
 * Opens a Scroll (exposure, document, activation) and hands it to `children` once it is ready. Every
 * other state has its screen: opening, unavailable, needs an update, offline, error. This is where
 * reading begins: nothing is opened before the person chose to read.
 *
 * A caller that can draw a v2 Scroll passes `stage`: the Scroll is then opened as the Stage + Spine reader's
 * document and handed to `stage`. Without it a v2 Scroll is "needs an app update", as it is for a caller that
 * cannot read one.
 */
export function OpenScroll({
  scope,
  assetId,
  onBack,
  children,
  stage,
}: {
  readonly scope: AccountScope;
  readonly assetId: string;
  readonly onBack: () => void;
  readonly children: (scroll: OpenedScroll) => ReactNode;
  readonly stage?: ((scroll: OpenedStageScroll) => ReactNode) | undefined;
}) {
  const { session, state } = useScrollSession(scope, assetId, { stage: stage !== undefined });
  useEffect(() => {
    session.start();
    return () => session.dispose();
  }, [session]);
  switch (state.status) {
    case 'ready':
      return <>{children(state.scroll)}</>;
    case 'ready_stage':
      return <>{stage?.(state.scroll)}</>;
    case 'opening':
    case 'loading':
    case 'activating':
      return (
        <Frame onBack={onBack}>
          <Skeleton rows={3} label="Opening the Scroll" />
        </Frame>
      );
    case 'unavailable':
      return (
        <Frame onBack={onBack}>
          <StateBlock title="This Scroll isn’t available" body="It may have been removed, or it isn’t yours to open." />
        </Frame>
      );
    case 'needs_update':
      return (
        <Frame onBack={onBack}>
          <StateBlock title="This needs an app update" body="This version of KnowScroll can’t show this Scroll yet." />
        </Frame>
      );
    case 'offline':
      return (
        <Frame onBack={onBack}>
          <OfflineState body="This Scroll opens once you’re back online." onRetry={() => session.start()} />
        </Frame>
      );
    case 'error':
      return (
        <Frame onBack={onBack}>
          <ErrorState
            title="Couldn’t open this Scroll"
            body="Something went wrong on our side. Try again in a moment."
            onRetry={() => session.start()}
          />
        </Frame>
      );
  }
}

/**
 * The article of an opened Scroll with its recorder: what is read here is an ordinary encounter of
 * the original Scroll, through the scope's durable outbox. `store` holds block state; a thread's
 * "open as set" passes one that keeps the sender's settings in memory only, so the reader's own
 * saved settings are never overwritten.
 */
export function ThreadScrollArticle({
  scope,
  scroll,
  store,
  anchorBlockId,
  afterHeader,
  floating,
  endSlot,
  chrome = 'floating',
}: {
  readonly scope: AccountScope;
  readonly scroll: OpenedScroll;
  readonly store?: ScrollBlockStateStore;
  readonly anchorBlockId?: string | undefined;
  readonly afterHeader?: ReactNode;
  /** Controls drawn over the article, top right. */
  readonly floating?: ReactNode;
  /** Drawn after the last block, inside the article (a branch's prompt to try another assumption). */
  readonly endSlot?: ReactNode;
  /**
   * `floating`: a Back button over the article's top-left, which the article leaves room for. `own`: the screen
   * draws its own header above the article (a branch has a return chip), so there is no button and no room reserved.
   */
  readonly chrome?: 'floating' | 'own';
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [recorder] = useState(() => recorderFor(scope, scroll));
  // Re-arm before the article's passive mount reports, including StrictMode setup.
  useLayoutEffect(() => {
    recorder.start();
    return () => recorder.end();
  }, [recorder]);
  const own = chrome === 'own';
  const ownStore = useMemo(() => createScopedBlockStateStore(scope.storage), [scope]);
  return (
    <View style={styles.article}>
      <ScrollArticle
        document={scroll.document}
        store={store ?? ownStore}
        observer={recorder.observer}
        anchorBlockId={anchorBlockId}
        afterHeader={afterHeader}
        endSlot={endSlot}
        testID="scroll-article"
        contentInset={{ top: own ? spacing[3] : insets.top + 72, bottom: spacing[24] + insets.bottom }}
        readingInset={{ top: own ? 0 : insets.top + 72, bottom: insets.bottom }}
      />
      {own && floating === undefined ? null : (
        <View style={[styles.floating, { top: own ? spacing[3] : insets.top + spacing[3] }]} pointerEvents="box-none">
          {own ? null : (
            <IconButton
              icon="back"
              label="Back to thread"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/conversations'))}
            />
          )}
          <View style={styles.grow} />
          {floating}
        </View>
      )}
    </View>
  );
}

/**
 * A v2 Scroll opened from a thread: the Stage + Spine reader `/scroll/<id>` draws, with the same recorder, so what is read
 * here is an ordinary encounter of the original Scroll. The thread supplies the way back and `endSlot`, its foot (the
 * finish of a part). Parts and related Scrolls are not offered: the next part is chosen in the thread, whose player is
 * the only thing that tells a place (D-153).
 */
export function ThreadStageScroll({
  scope,
  scroll,
  onBack,
  endSlot,
}: {
  readonly scope: AccountScope;
  readonly scroll: OpenedStageScroll;
  readonly onBack: () => void;
  readonly endSlot?: ReactNode;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  useDocumentTitle(scroll.document.title);
  const [recorder] = useState(() => recorderFor(scope, scroll));
  // A Scroll that another screen covers is not being read: its time stops until it is back.
  const focused = useIsFocused();
  useLayoutEffect(() => {
    recorder.start();
    return () => recorder.end();
  }, [recorder]);
  return (
    <StageReaderSurface
      scroll={scroll}
      observer={recorder.observer}
      paused={!focused}
      moves={{ universe: () => router.navigate('/universe'), done: onBack }}
      headerNote={
        <View style={styles.back}>
          <Button label="Back to thread" icon="back" variant="ghost" size="sm" onPress={onBack} />
        </View>
      }
      endSlot={endSlot}
      topInset={insets.top + spacing[3]}
      bottomInset={insets.bottom}
    />
  );
}

const styles = StyleSheet.create({
  back: { alignItems: 'flex-start', paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
  ground: { flex: 1, backgroundColor: content.paper, paddingHorizontal: layout.gutter },
  state: { paddingTop: spacing[9], alignItems: 'center' },
  article: { flex: 1, backgroundColor: content.paper },
  floating: {
    position: 'absolute',
    left: layout.gutter,
    right: layout.gutter,
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: { flex: 1 },
});
