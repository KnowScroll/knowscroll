import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createScrollRecorder, type AccountScope } from '@knowscroll/client-core';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  ActionStrip,
  Banner,
  ErrorState,
  FormatSwitch,
  IconButton,
  OfflineState,
  Skeleton,
  StateBlock,
  useDisplay,
  type ScrollPositionHandle,
  type StageReaderHandle,
} from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useFormatSiblings } from '../encounter/use-format-siblings';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { useKeepSurface } from '../saved/use-keep-surface';
import { KeepWriteStatus } from '../saved/keep-detail';
import { EvidencePanel } from '../diagnostics/evidence-panel';
import { combineObservers, createAnchorKeeper } from './anchor-keeper';
import type { OpenedScroll, OpenedStageScroll } from './scroll-session';
import { StageReaderSurface } from './stage-reader-surface';
import { useAddressMoves } from './use-address-moves';
import { useScrollSession } from './use-scroll-session';
import { ActivatedScrollView } from './activated-scroll-view';
import { readResume, writeResume } from '../encounter/encounter-history';

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

type KeepState = ReturnType<typeof useKeepSurface>;

/** Save, and what to say when saving or the remembered place is not settled (shared by both readers). */
function KeepActions({
  kept,
  isKept,
  capture,
  degraded,
}: {
  readonly kept: KeepState;
  readonly isKept: boolean;
  readonly capture: () => unknown;
  readonly degraded: boolean;
}) {
  return (
    <View style={{ gap: spacing[3] }}>
      {degraded ? (
        <Banner kind="info" lead="Part of this Scroll needs an app update." message="It is shown here as text." />
      ) : null}
      <ActionStrip
        available={['save']}
        saved={isKept}
        saving={kept.state.save === 'sending'}
        onAction={() => {
          if (isKept) return;
          capture();
          void kept.surface.save();
        }}
      />
      {kept.state.save === 'unavailable' ? (
        <Banner kind="info" lead="Couldn't save yet." message="Earlier saves still need confirming." />
      ) : null}
      {kept.state.save === 'unknown' ? (
        <Banner
          kind="error"
          lead="Save wasn't confirmed."
          message="Retrying checks the same save."
          action={{
            label: 'Retry Save',
            onPress: () => {
              capture();
              void kept.surface.save();
            },
          }}
        />
      ) : null}
      {kept.state.place.write === 'unknown' || kept.state.place.write === 'conflict' ? (
        <KeepWriteStatus
          state={kept.state.place}
          refresh={kept.surface.refresh}
          retry={kept.surface.retry}
          resolve={kept.surface.resolveConflict}
        />
      ) : null}
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
  const siblings = useFormatSiblings(scope, scroll.exposureId, 'scroll');
  const params = useLocalSearchParams<{ anchor?: string | string[] }>();
  useDocumentTitle(scroll.document.title);
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
  const positionRef = useRef<ScrollPositionHandle>(null);
  const target = useMemo(() => ({ assetId: scroll.assetId, assetRevision: scroll.assetRevision }), [scroll]);
  const capture = useCallback(() => {
    const value = positionRef.current?.capture();
    if (
      !value ||
      value.assetId !== scroll.assetId ||
      value.revision !== scroll.assetRevision ||
      !Number.isFinite(value.offsetWithinBlock) ||
      value.offsetWithinBlock < 0 ||
      !scroll.document.sections.some((section) => section.blocks.some((block) => block.id === value.blockId))
    )
      return undefined;
    writeResume(scope, scroll.assetId, scroll.assetRevision, { kind: 'scroll', value });
    return { kind: 'scroll' as const, blockId: value.blockId, offsetWithinBlock: value.offsetWithinBlock };
  }, [scope, scroll]);
  const kept = useKeepSurface(scope, target, scroll.exposureId, capture);
  const isKept =
    kept.state.place.snapshot?.status === 'available' || kept.state.place.snapshot?.status === 'saved_unavailable';
  const [resume] = useState(() => readResume(scope, scroll.assetId, scroll.assetRevision));
  useLayoutEffect(
    () => () => {
      const value = positionRef.current?.capture();
      if (value) writeResume(scope, scroll.assetId, scroll.assetRevision, { kind: 'scroll', value });
    },
    [scope, scroll],
  );
  // Re-arm before the article's passive mount/activity reports, including StrictMode setup.
  // Actual native layout and web intersection measurements arrive after the commit.
  useLayoutEffect(() => {
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
  const [anchorBlockId] = useState(
    () => firstOf(params.anchor) ?? (resume?.kind === 'scroll' ? undefined : keeper.restore()),
  );
  return (
    <View style={styles.article}>
      <View style={[styles.top, { paddingTop: insets.top + spacing[3] }]}>
        <IconButton icon="back" label="Back" onPress={back} />
        <View style={styles.spacer} />
        <FormatSwitch selected="scroll" availability={siblings.availability} showIcons onSelect={siblings.select} />
      </View>
      <ActivatedScrollView
        scope={scope}
        scroll={scroll}
        key={`${scroll.assetId}:${String(scroll.assetRevision)}:${anchorBlockId ?? ''}`}
        observer={observer}
        positionRef={positionRef}
        initialPosition={firstOf(params.anchor) === undefined && resume?.kind === 'scroll' ? resume.value : undefined}
        onPositionChange={(value) =>
          writeResume(scope, scroll.assetId, scroll.assetRevision, { kind: 'scroll', value })
        }
        {...(anchorBlockId === undefined ? {} : { anchorBlockId })}
        topInset={spacing[3]}
        bottomInset={spacing[24] + insets.bottom}
        readingBottomInset={insets.bottom}
        afterHeader={
          <KeepActions kept={kept} isKept={isKept} capture={capture} degraded={scroll.degradedEssential.length > 0} />
        }
      />
      <EvidencePanel scope={scope} exposureId={scroll.exposureId} />
    </View>
  );
}

/**
 * A v2 Scroll on its own address: the Stage + Spine reader with the same recorder and the same
 * remembered place as the article, by stop (a stop id is the position's block id). The Parts and the
 * related move are the ones the server admitted for this Scroll, opened by address (D-184); there is
 * no encounter, so no Ask. Next ↑ goes to Explore for a new topic.
 */
function ReadyStageScroll({ scope, scroll }: { readonly scope: AccountScope; readonly scroll: OpenedStageScroll }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const back = useBack();
  const siblings = useFormatSiblings(scope, scroll.exposureId, 'scroll');
  const params = useLocalSearchParams<{ anchor?: string | string[] }>();
  const { breakpoint } = useDisplay();
  const narrow = breakpoint === 'compact' || breakpoint === 'phone';
  useDocumentTitle(scroll.document.title);
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
  const reader = useRef<StageReaderHandle>(null);
  const target = useMemo(() => ({ assetId: scroll.assetId, assetRevision: scroll.assetRevision }), [scroll]);
  const remember = useCallback(
    (stopId: string) => {
      const value = { assetId: scroll.assetId, revision: scroll.assetRevision, blockId: stopId, offsetWithinBlock: 0 };
      writeResume(scope, scroll.assetId, scroll.assetRevision, { kind: 'scroll', value });
      return { kind: 'scroll' as const, blockId: stopId, offsetWithinBlock: 0 };
    },
    [scope, scroll],
  );
  const capture = useCallback(() => {
    const stop = reader.current?.capture();
    return stop === undefined ? undefined : remember(stop.stopId);
  }, [remember]);
  const kept = useKeepSurface(scope, target, scroll.exposureId, capture);
  const isKept =
    kept.state.place.snapshot?.status === 'available' || kept.state.place.snapshot?.status === 'saved_unavailable';
  const [resume] = useState(() => readResume(scope, scroll.assetId, scroll.assetRevision));
  useLayoutEffect(() => {
    recorder.start();
    return () => recorder.end();
  }, [recorder]);
  const initialStopId = firstOf(params.anchor) ?? (resume?.kind === 'scroll' ? resume.value.blockId : undefined);
  const moves = useAddressMoves(scope, scroll.exposureId);
  // The count is the server's; the Scroll's own Part number stands in until the context arrives.
  const ownPart = scroll.document.series?.part;
  const partLabel = moves.partLabel ?? (ownPart === undefined ? undefined : `Part ${String(ownPart)}`);
  return (
    <>
      <StageReaderSurface
        scroll={scroll}
        observer={recorder.observer}
        initialStopId={initialStopId}
        handleRef={reader}
        onStopChange={(stopId) => {
          if (stopId !== undefined) remember(stopId);
        }}
        partLabel={partLabel}
        moves={{
          universe: () => router.navigate('/universe'),
          nextTopic: () => router.navigate('/explore'),
          nextPart: moves.nextPart,
          related: moves.related,
          previousPart: moves.previousPart,
          formatSwitch: (
            <FormatSwitch
              selected="scroll"
              availability={siblings.availability}
              showIcons={!narrow}
              terse={narrow}
              onSelect={siblings.select}
            />
          ),
          format: () => siblings.select('reel'),
          done: back,
        }}
        moreBody={() => <KeepActions kept={kept} isKept={isKept} capture={capture} degraded={false} />}
        topInset={insets.top + spacing[3]}
        bottomInset={insets.bottom}
      />
      <EvidencePanel scope={scope} exposureId={scroll.exposureId} />
    </>
  );
}

function SignedInScroll({ scope, assetId }: { readonly scope: AccountScope; readonly assetId: string }) {
  const router = useRouter();
  const { session, state } = useScrollSession(scope, assetId, { stage: true });
  useEffect(() => {
    session.start();
    return () => session.dispose();
  }, [session]);
  useDocumentTitle('Scroll');
  switch (state.status) {
    case 'ready':
      return <ReadyScroll scope={scope} scroll={state.scroll} />;
    case 'ready_stage':
      return <ReadyStageScroll key={state.scroll.exposureId} scope={scope} scroll={state.scroll} />;
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
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[2],
  },
  spacer: { flex: 1 },
});
