import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import {
  EdgeTab,
  ReelProgress,
  Tag,
  Text,
  type ReelControls,
  type ReelPlaybackView,
  type ReelPositionHandle,
} from '@knowscroll/ui';
import { ActivatedReelView } from '../reel/activated-reel-view';
import { useReelPageStage } from '../reel/reel-page';
import { continuationIntent, continuationLabel, continuationName } from './continuation-intent';
import { EncounterRail } from './encounter-actions';
import { retainReelMuted, type EncounterEntry } from './encounter-history';
import { useEncounterMetrics, type EncounterMetrics } from './encounter-metrics';
import { EncounterNotices } from './encounter-notices';
import type { EncounterSession, EncounterState } from './encounter-session';
import { EncounterTopBar } from './encounter-top-bar';
import type { EncounterGestureMove } from './gestures/arbitration';
import { ReelGestureStage } from './gestures/reel-gesture-stage';

type ReelEntry = Extract<EncounterEntry, { kind: 'reel' }>;

/** Room the edge tabs take beside the title and, on a short screen, beside the progress row. */
const EDGE_TAB_WIDTH = 76;

/** The yellow Part tab, the dashed Related tab and the previous step, on the Reel's edges (E05). */
function ContinuationTabs({
  entry,
  session,
  disabled,
  metrics,
}: {
  readonly entry: ReelEntry;
  readonly session: EncounterSession;
  readonly disabled: boolean;
  readonly metrics: EncounterMetrics;
}) {
  const { seriesNext, seriesPrevious, related } = entry.context.continuations;
  const next = seriesNext.status === 'ready' ? seriesNext : related.status === 'ready' ? related : undefined;
  const previous = seriesPrevious.status === 'ready' ? seriesPrevious : undefined;
  // On a short screen the tabs sit beside the progress row, below the compact rail; otherwise beside the title.
  const tabBottom = metrics.short ? metrics.bottom + spacing[2] : metrics.bottom + 52 + spacing[4];
  return (
    <View testID="encounter-continuation-edges" style={styles.fill} pointerEvents="box-none">
      {previous ? (
        <View style={[styles.startEdge, { bottom: tabBottom }]}>
          <EdgeTab
            kind="previous"
            label={continuationLabel(previous)}
            accessibilityLabel={continuationName(previous, 'previous')}
            disabled={disabled}
            onPress={() => session.navigate(continuationIntent(previous, 'previous'))}
          />
        </View>
      ) : null}
      {next ? (
        <View style={[styles.endEdge, { bottom: tabBottom }]}>
          <EdgeTab
            kind={next.relation.kind === 'series_step' ? 'part' : 'related'}
            label={continuationLabel(next)}
            accessibilityLabel={continuationName(next)}
            disabled={disabled}
            onPress={() => session.navigate(continuationIntent(next))}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Everything drawn over the video except the stage itself (E01). In a `framed` Reel (D01) the top
 * controls, the action rail and the continuation tabs sit around the card, in the desktop shell,
 * so only the notices, the title and the progress row stay over the video.
 */
function ReelChrome({
  entry,
  state,
  session,
  playback,
  back,
  hint,
  framed,
}: {
  readonly entry: ReelEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly playback: ReelPlaybackView;
  readonly back: () => void;
  readonly hint: ReactNode;
  readonly framed: boolean;
}) {
  const metrics = useEncounterMetrics();
  const idle = state.phase !== 'active';
  const progressBottom = metrics.bottom + spacing[2];
  const titleBottom = progressBottom + 44 + spacing[3];
  return (
    <>
      <View
        // Names the window size this chrome was laid out for: a resize reaches the chrome in a later
        // React commit than the stage's own CSS reflow, and the e2e waits for this to match.
        testID={`reel-chrome-${String(metrics.window.width)}x${String(metrics.window.height)}`}
        style={[styles.top, { top: metrics.top, left: metrics.side, right: metrics.side }]}
        pointerEvents="box-none"
      >
        {framed ? null : <EncounterTopBar entry={entry} session={session} surface="media" back={back} />}
        <View style={styles.notices} pointerEvents="box-none">
          <EncounterNotices entry={entry} state={state} session={session} />
        </View>
      </View>
      {framed ? null : (
        <>
          <View
            style={[styles.rail, { top: metrics.top + (metrics.short ? 56 : 160), right: spacing[3] }]}
            pointerEvents="box-none"
          >
            <EncounterRail entry={entry} state={state} session={session} dense={metrics.short} />
          </View>
          <ContinuationTabs entry={entry} session={session} disabled={idle} metrics={metrics} />
        </>
      )}
      <View
        testID="encounter-reel-caption"
        style={[
          styles.title,
          { bottom: titleBottom, left: spacing[5], right: spacing[5] + (framed ? 0 : EDGE_TAB_WIDTH) },
        ]}
        pointerEvents="none"
      >
        {entry.context.series ? <Tag label={`Part ${String(entry.context.series.part)}`} variant="part" /> : null}
        <Text variant="heading" heading={2} color={content.paper} style={styles.titleText}>
          {entry.document.title}
        </Text>
      </View>
      <View
        style={[
          styles.progress,
          {
            bottom: progressBottom,
            left: spacing[5],
            right: framed ? spacing[5] : metrics.short ? spacing[3] + EDGE_TAB_WIDTH : spacing[3],
          },
        ]}
        pointerEvents="box-none"
      >
        <ReelProgress
          positionMs={playback.positionMs}
          durationMs={playback.durationMs}
          muted={playback.muted}
          onToggleMuted={playback.toggleMuted}
        />
      </View>
      {hint === null ? null : <View style={[styles.hint, { bottom: metrics.bottom + spacing[4] }]}>{hint}</View>}
    </>
  );
}

/**
 * A Reel as drawn in E01: the video fills the screen and the chrome sits over it. Swipe up is the
 * next subject, sideways continues the idea, a tap pauses; every one of those also has a control.
 * The chrome is a sibling of the stage's gesture wrapper, so buttons never start a swipe.
 */
export function ReelEncounter({
  scope,
  entry,
  state,
  session,
  foreground,
  back,
  hint,
  framed = false,
}: {
  readonly scope: AccountScope;
  readonly entry: ReelEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly foreground: boolean;
  readonly back: () => void;
  readonly hint: ReactNode;
  /** The desktop card (D01): the shell draws the top controls, actions and tabs around the video. */
  readonly framed?: boolean;
}) {
  const reelPosition = useRef<ReelPositionHandle>(null);
  const reelControls = useRef<ReelControls>(null);
  const retainedGrant = useMemo(() => session.mediaGrant(entry), [entry, session]);
  const onMove = useCallback((move: EncounterGestureMove) => session.gesture(move), [session]);
  const onMenu = useCallback(() => session.openFeedback('menu'), [session]);
  const playable = foreground && !state.overlay && state.phase === 'active';
  const pause = useCallback(() => reelPosition.current?.pause(), []);
  const visibility = useReelPageStage(scope, playable, pause);
  const renderStage = useCallback(
    (stage: ReactNode) => (
      <View ref={visibility.ref} onLayout={visibility.onLayout} style={styles.fill}>
        <ReelGestureStage onMove={onMove} onToggle={() => reelControls.current?.toggle()} onMenu={onMenu}>
          {stage}
        </ReelGestureStage>
      </View>
    ),
    [onMove, onMenu, visibility.ref, visibility.onLayout],
  );
  const onMutedChange = useCallback(
    (muted: boolean) => {
      retainReelMuted(scope, entry, muted);
    },
    [scope, entry],
  );
  useLayoutEffect(() => {
    if (!playable) return;
    session.bindSurface(entry, {
      capture: () => {
        const value = reelPosition.current?.capture();
        return value ? { kind: 'reel', ...value } : undefined;
      },
      pause: () => reelPosition.current?.pause(),
    });
    // Parent layout setup re-arms the retained recorder before child activity passive setup.
    session.mount(entry);
    return () => session.park(entry);
  }, [entry, session, playable]);
  return (
    <ActivatedReelView
      scope={scope}
      exposureId={entry.exposureId}
      document={entry.document}
      recorder={entry.recorder}
      active={playable && visibility.visible}
      retainedGrant={retainedGrant}
      renderStage={renderStage}
      positionRef={reelPosition}
      controls={{ controlsRef: reelControls }}
      initialPositionMs={entry.position?.kind === 'reel' ? entry.position.positionMs : entry.restored ? 0 : undefined}
      initialPlaying={entry.resumePlaying === true}
      initialMuted={entry.muted ?? (entry.position?.kind === 'reel' ? entry.position.muted : false)}
      onMutedChange={onMutedChange}
    >
      {(playback) => (
        <ReelChrome
          entry={entry}
          state={state}
          session={session}
          playback={playback}
          back={back}
          hint={hint}
          framed={framed}
        />
      )}
    </ActivatedReelView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  top: { position: 'absolute', gap: spacing[2] },
  notices: { alignSelf: 'stretch' },
  rail: { position: 'absolute' },
  title: { position: 'absolute', gap: spacing[2] },
  titleText: { textShadowColor: 'rgba(17,17,17,0.45)', textShadowRadius: 8, textShadowOffset: { width: 0, height: 1 } },
  progress: { position: 'absolute' },
  hint: { position: 'absolute', left: spacing[4], right: spacing[4] },
  startEdge: { position: 'absolute', left: 0 },
  endEdge: { position: 'absolute', right: 0 },
});
