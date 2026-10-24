import { useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createScopedBlockStateStore,
  createScrollRecorder,
  type AccountScope,
  type ScrollBlockStateStore,
} from '@knowscroll/client-core';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { ErrorState, IconButton, OfflineState, ScrollArticle, Skeleton, StateBlock } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import type { OpenedScroll } from '../scroll/scroll-session';
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
 */
export function OpenScroll({
  scope,
  assetId,
  onBack,
  children,
}: {
  readonly scope: AccountScope;
  readonly assetId: string;
  readonly onBack: () => void;
  readonly children: (scroll: OpenedScroll) => ReactNode;
}) {
  const { session, state } = useScrollSession(scope, assetId);
  useEffect(() => {
    session.start();
    return () => session.dispose();
  }, [session]);
  switch (state.status) {
    case 'ready':
      return <>{children(state.scroll)}</>;
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
}: {
  readonly scope: AccountScope;
  readonly scroll: OpenedScroll;
  readonly store?: ScrollBlockStateStore;
  readonly anchorBlockId?: string | undefined;
  readonly afterHeader?: ReactNode;
  /** Controls drawn over the article, top right. */
  readonly floating?: ReactNode;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [recorder] = useState(() =>
    createScrollRecorder({
      exposure: {
        exposureId: scroll.exposureId,
        assetId: scroll.assetId,
        assetRevision: scroll.assetRevision,
        ...(scroll.recordingGeneration === undefined ? {} : { recordingGeneration: scroll.recordingGeneration }),
        ...(scroll.recordingSessionId === undefined ? {} : { recordingSessionId: scroll.recordingSessionId }),
      },
      scope,
      newId: newCommandId,
    }),
  );
  // Re-arm before the article's passive mount reports, including StrictMode setup.
  useLayoutEffect(() => {
    recorder.start();
    return () => recorder.end();
  }, [recorder]);
  const own = useMemo(() => createScopedBlockStateStore(scope.storage), [scope]);
  return (
    <View style={styles.article}>
      <ScrollArticle
        document={scroll.document}
        store={store ?? own}
        observer={recorder.observer}
        anchorBlockId={anchorBlockId}
        afterHeader={afterHeader}
        testID="scroll-article"
        contentInset={{ top: insets.top + 72, bottom: spacing[24] + insets.bottom }}
        readingInset={{ top: insets.top + 72, bottom: insets.bottom }}
      />
      <View style={[styles.floating, { top: insets.top + spacing[3] }]} pointerEvents="box-none">
        <IconButton
          icon="back"
          label="Back to thread"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/conversations'))}
        />
        <View style={styles.grow} />
        {floating}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
