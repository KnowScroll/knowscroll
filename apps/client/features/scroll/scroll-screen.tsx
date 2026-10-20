import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createScrollRecorder, type AccountScope } from '@knowscroll/client-core';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Banner, ErrorState, IconButton, OfflineState, Skeleton, StateBlock } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { EvidencePanel } from '../diagnostics/evidence-panel';
import { combineObservers, createAnchorKeeper } from './anchor-keeper';
import type { OpenedScroll } from './scroll-session';
import { TemporaryArticle } from './temporary-article';
import { useScrollSession } from './use-scroll-session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route value: Expo Router gives a string, or the list when the parameter repeats. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The back control and the room it takes above the article. */
function useBack() {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace('/explore');
  };
}

/** One quiet screen for every state that is not the article itself. */
function Frame({ children }: { readonly children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const back = useBack();
  return (
    <View role="main" style={[styles.ground, { paddingTop: insets.top + spacing[3] }]}>
      <View style={styles.bar}>
        <IconButton icon="back" label="Back" onPress={back} />
      </View>
      <View style={styles.state}>{children}</View>
    </View>
  );
}

/**
 * The article of an opened Scroll, with its recorder. The recorder starts only now: the exposure was
 * activated before this mounted, so every observation has lineage. It reports through the scope's
 * durable outbox; when the screen unmounts (Back, sign-out, a scope change) it reports the final
 * time. The position the person reached is remembered by block and restored on return.
 */
function ReadyScroll({ scope, scroll }: { readonly scope: AccountScope; readonly scroll: OpenedScroll }) {
  const insets = useSafeAreaInsets();
  const back = useBack();
  const params = useLocalSearchParams<{ anchor?: string | string[] }>();
  useDocumentTitle(scroll.document.title);
  const [recorder] = useState(() =>
    createScrollRecorder({
      exposure: { exposureId: scroll.exposureId, assetId: scroll.assetId, assetRevision: scroll.assetRevision },
      scope,
      newId: newCommandId,
    }),
  );
  useEffect(() => {
    recorder.start();
    return () => recorder.end();
  }, [recorder]);
  const keeper = useMemo(
    () =>
      createAnchorKeeper({
        assetId: scroll.assetId,
        revision: scroll.assetRevision,
        order: scroll.document.sections.flatMap((section) => section.blocks.map((block) => block.id)),
        storage: scope.storage,
      }),
    [scope, scroll],
  );
  useLayoutEffect(() => {
    keeper.start();
    // Parent cleanup runs before the article cleanup: closing recorder intervals must not move resume.
    return () => keeper.stop();
  }, [keeper]);
  const observer = useMemo(() => combineObservers(recorder.observer, keeper.observer), [recorder, keeper]);
  // A deep link names the block (`?anchor=<blockId>`); otherwise the person's own last position.
  const [anchorBlockId] = useState(() => firstOf(params.anchor) ?? keeper.restore());
  return (
    <View style={styles.article}>
      <TemporaryArticle
        document={scroll.document}
        observer={observer}
        {...(anchorBlockId === undefined ? {} : { anchorBlockId })}
        contentInset={{ top: insets.top + 72, bottom: spacing[24] + insets.bottom }}
        afterHeader={
          scroll.degradedEssential.length > 0 ? (
            <Banner kind="info" lead="Part of this Scroll needs an app update." message="It is shown here as text." />
          ) : undefined
        }
      />
      <View style={[styles.floating, { top: insets.top + spacing[3] }]} pointerEvents="box-none">
        <IconButton icon="back" label="Back" onPress={back} />
      </View>
      <EvidencePanel scope={scope} exposureId={scroll.exposureId} />
    </View>
  );
}

function SignedInScroll({ scope, assetId }: { readonly scope: AccountScope; readonly assetId: string }) {
  const router = useRouter();
  const { session, state } = useScrollSession(scope, assetId);
  useEffect(() => {
    session.start();
    return () => session.dispose();
  }, [session]);
  useDocumentTitle('Scroll');
  switch (state.status) {
    case 'ready':
      return <ReadyScroll scope={scope} scroll={state.scroll} />;
    case 'opening':
    case 'loading':
    case 'activating':
      return (
        <Frame>
          <Skeleton rows={3} label="Opening the Scroll" />
        </Frame>
      );
    case 'unavailable':
      return (
        <Frame>
          <StateBlock
            title="This Scroll isn't available"
            body="It may have been removed, or it isn't yours to open."
            actions={[
              {
                label: 'Go to Explore',
                role: 'link',
                href: '/explore',
                variant: 'primary',
                onPress: () => router.replace('/explore'),
              },
            ]}
          />
        </Frame>
      );
    case 'needs_update':
      return (
        <Frame>
          <StateBlock title="This needs an app update" body="This version of KnowScroll can't show this Scroll yet." />
        </Frame>
      );
    case 'offline':
      return (
        <Frame>
          <OfflineState body="This Scroll opens once you're back online." onRetry={() => session.start()} />
        </Frame>
      );
    case 'error':
      return (
        <Frame>
          <ErrorState
            title="Couldn't open this Scroll"
            body="Something went wrong on our side. Try again in a moment."
            onRetry={() => session.start()}
          />
        </Frame>
      );
  }
}

/**
 * `/scroll/[assetId]` (D-006 d): opens an admitted Scroll for the signed-in person (the exposure
 * and its lineage), renders it, records what is read, and restores the position by block. Signed
 * out, it asks for the sign-in the rest of the app uses; an address that is not an asset is
 * "isn't available".
 */
export function ScrollScreen() {
  const params = useLocalSearchParams<{ assetId?: string | string[] }>();
  const assetId = firstOf(params.assetId);
  const router = useRouter();
  const { state } = useAccountScope();
  if (assetId === undefined || !UUID.test(assetId)) {
    return (
      <Frame>
        <StateBlock
          title="This Scroll isn't available"
          body="The address doesn't name a Scroll."
          actions={[
            {
              label: 'Go to Explore',
              role: 'link',
              href: '/explore',
              variant: 'primary',
              onPress: () => router.replace('/explore'),
            },
          ]}
        />
      </Frame>
    );
  }
  if (state.status === 'signed_in') return <SignedInScroll scope={state.scope} assetId={assetId.toLowerCase()} />;
  return (
    <Frame>
      <StateBlock
        title={state.status === 'unavailable' ? "Can't reach KnowScroll" : "You're not signed in"}
        body={
          state.status === 'unavailable'
            ? 'This Scroll opens once the connection is back.'
            : 'Sign in with your email to read it.'
        }
        actions={
          state.status === 'unavailable'
            ? []
            : [
                {
                  label: 'Sign in',
                  role: 'link',
                  href: '/welcome',
                  variant: 'primary',
                  onPress: () => router.navigate('/welcome'),
                },
              ]
        }
      />
    </Frame>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper, paddingHorizontal: layout.gutter },
  bar: { minHeight: 48, justifyContent: 'center', alignItems: 'flex-start' },
  state: { paddingTop: spacing[9], alignItems: 'center' },
  article: { flex: 1, backgroundColor: content.paper },
  floating: { position: 'absolute', left: layout.gutter },
});
