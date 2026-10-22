import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Text, type ReelPositionHandle, type ScrollPositionHandle } from '@knowscroll/ui';
import { ActivatedScrollView } from '../scroll/activated-scroll-view';
import { useReelPageStage } from '../reel/reel-page';
import { ActivatedReelView } from '../reel/activated-reel-view';
import { EncounterEdges } from './encounter-edges';
import { EncounterActions } from './encounter-chrome';
import type { EncounterGestureMove } from './gestures/arbitration';
import { ReelGestureStage } from './gestures/reel-gesture-stage';
import { ContinuationControls } from './continuation-controls';
import { retainReelMuted, type EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

export function EncounterView({
  scope,
  entry,
  state,
  session,
  foreground,
}: {
  readonly scope: AccountScope;
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly foreground: boolean;
}) {
  const scrollPosition = useRef<ScrollPositionHandle>(null);
  const reelPosition = useRef<ReelPositionHandle>(null);
  const retainedGrant = useMemo(() => session.mediaGrant(entry), [entry, session]);
  const onMove = useCallback((move: EncounterGestureMove) => session.gesture(move), [session]);
  const playable = foreground && !state.overlay && state.phase === 'active';
  const pause = useCallback(() => reelPosition.current?.pause(), []);
  const visibility = useReelPageStage(scope, playable, pause);
  const renderStage = useCallback(
    (stage: React.ReactNode) => (
      <View ref={visibility.ref} onLayout={visibility.onLayout} style={styles.mediaStage}>
        <ReelGestureStage onMove={onMove}>{stage}</ReelGestureStage>
        <EncounterEdges entry={entry} session={session} disabled={state.phase !== 'active'} />
      </View>
    ),
    [onMove, entry, session, state.phase, visibility.ref, visibility.onLayout],
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
        if (entry.kind === 'scroll') {
          const value = scrollPosition.current?.capture();
          return value ? { kind: 'scroll', value } : undefined;
        }
        const value = reelPosition.current?.capture();
        return value ? { kind: 'reel', ...value } : undefined;
      },
      pause: () => reelPosition.current?.pause(),
    });
    // Parent layout setup re-arms the retained recorder before child activity passive setup.
    session.mount(entry);
    return () => session.park(entry);
  }, [entry, session, playable]);
  if (entry.kind === 'scroll')
    return (
      <ActivatedScrollView
        scope={scope}
        scroll={entry.scroll}
        observer={entry.recorder.observer}
        positionRef={scrollPosition}
        initialPosition={entry.position?.kind === 'scroll' ? entry.position.value : undefined}
        paused={!playable}
        topInset={spacing[4]}
        bottomInset={spacing[24]}
        afterHeader={<EncounterActions state={state} session={session} />}
        endSlot={<ContinuationControls entry={entry} session={session} disabled={state.phase !== 'active'} />}
      />
    );
  return (
    <View style={styles.reel}>
      <ActivatedReelView
        scope={scope}
        exposureId={entry.exposureId}
        document={entry.document}
        recorder={entry.recorder}
        active={playable && visibility.visible}
        retainedGrant={retainedGrant}
        renderStage={renderStage}
        positionRef={reelPosition}
        initialPositionMs={entry.position?.kind === 'reel' ? entry.position.positionMs : entry.restored ? 0 : undefined}
        initialMuted={entry.muted ?? (entry.position?.kind === 'reel' ? entry.position.muted : false)}
        onMutedChange={onMutedChange}
      />
      <View testID="encounter-reel-caption" style={styles.caption}>
        <Text variant="title" color={content.paper}>
          {entry.document.title}
        </Text>
        <Text variant="bodyS" color={content.paper}>
          {entry.document.summary}
        </Text>
      </View>
      <EncounterActions state={state} session={session} />
    </View>
  );
}
const styles = StyleSheet.create({
  reel: { flexShrink: 0 },
  mediaStage: { flex: 1, minHeight: 0, position: 'relative' },
  caption: { padding: spacing[3], gap: spacing[2], backgroundColor: content.ink },
});
