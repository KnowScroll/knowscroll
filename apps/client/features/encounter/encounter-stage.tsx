import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, useDisplay, type StageReaderHandle } from '@knowscroll/ui';
import { StageReaderSurface } from '../scroll/stage-reader-surface';
import { isStageScroll, type OpenedStageScroll } from '../scroll/scroll-session';
import { continuationIntent } from './continuation-intent';
import { readerContinuations } from './continuation-moves';
import { EncounterStrip } from './encounter-actions';
import type { EncounterEntry } from './encounter-history';
import { useEncounterMetrics } from './encounter-metrics';
import { EncounterNotices } from './encounter-notices';
import { encounterOrigin } from './encounter-origin';
import { EncounterOriginChip } from './encounter-origin-chip';
import type { EncounterSession, EncounterState } from './encounter-session';
import { EncounterFormatSwitch } from './encounter-top-bar';

export type StageEntry = Extract<EncounterEntry, { kind: 'scroll' }> & { readonly scroll: OpenedStageScroll };

/** Whether a Scroll entry holds a v2 document. The entry itself is kept: the session tracks entries by identity. */
export function isStageEntry(entry: Extract<EncounterEntry, { kind: 'scroll' }>): entry is StageEntry {
  return isStageScroll(entry.scroll);
}

/**
 * A v2 Scroll in the Explore encounter (V3 A1, G1 to G3): the Stage + Spine reader in place of the
 * article. Vertical reading never navigates; the Part moves and Next are the same navigation the
 * Reel's edge tabs and the end card of a v1 Scroll make, through the same session, so a continuation
 * is only ever one the server admitted (the displayed link travels with the move).
 */
export function StageEncounter({
  entry,
  state,
  session,
  foreground,
  back,
  hint,
}: {
  readonly entry: StageEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly foreground: boolean;
  readonly back: () => void;
  readonly hint: ReactNode;
}) {
  const router = useRouter();
  const { breakpoint } = useDisplay();
  const narrow = breakpoint === 'compact' || breakpoint === 'phone';
  const metrics = useEncounterMetrics();
  const reader = useRef<StageReaderHandle>(null);
  const playable = foreground && !state.overlay && state.phase === 'active';
  const origin = encounterOrigin(state.trail, entry, session.regionOriginOf(entry));
  const moves = readerContinuations(entry.context.continuations, (state, direction) =>
    session.navigate(continuationIntent(state, direction)),
  );
  const series = entry.context.series;
  const reel = entry.context.variants.find((variant) => variant.kind === 'reel');
  useLayoutEffect(() => {
    if (!playable) return;
    session.bindSurface(entry, {
      capture: () => {
        const stop = reader.current?.capture();
        if (stop === undefined) return undefined;
        const value = {
          assetId: entry.offer.assetId,
          revision: entry.offer.assetRevision,
          blockId: stop.stopId,
          offsetWithinBlock: 0,
        };
        return { kind: 'scroll', value };
      },
      pause: () => undefined,
    });
    session.mount(entry);
    return () => session.park(entry);
  }, [entry, session, playable]);
  return (
    <View style={styles.page}>
      <StageReaderSurface
        scroll={entry.scroll}
        observer={entry.recorder.observer}
        paused={!playable}
        initialStopId={entry.position?.kind === 'scroll' ? entry.position.value.blockId : undefined}
        handleRef={reader}
        partLabel={series === undefined ? undefined : `Part ${String(series.part)} of ${String(series.total)}`}
        moves={{
          universe: () => router.navigate('/universe'),
          nextTopic: () => session.navigate({ mode: 'vertical', direction: 'next' }),
          ...moves,
          // Ask from here (D1): the question is anchored to the stop on screen, or the last one at the end of the Scroll.
          ask: () => {
            const stopId = reader.current?.capture()?.stopId ?? entry.scroll.document.stops.at(-1)?.id;
            if (stopId === undefined) session.openRequest();
            else session.openRequest('ask', { stopId });
          },
          formatSwitch: <EncounterFormatSwitch entry={entry} session={session} showIcons={!narrow} terse={narrow} />,
          format: () =>
            reel?.status === 'ready' ? session.navigate({ mode: 'variant', to: 'reel' }) : session.openRequest('reel'),
          done: back,
        }}
        moreBody={(close) => (
          <View style={styles.more}>
            <EncounterStrip entry={entry} state={state} session={session} align="start" beforeOverlay={close} />
            <Button
              label="Your path and more options"
              onPress={() => {
                close();
                session.setOverlay(true);
              }}
            />
          </View>
        )}
        headerNote={
          origin === undefined ? null : (
            <View style={styles.origin}>
              <EncounterOriginChip origin={origin} onBack={back} />
            </View>
          )
        }
        topInset={metrics.top}
        bottomInset={metrics.bottom}
      />
      <View style={[styles.notices, { left: metrics.side, right: metrics.side }]} pointerEvents="box-none">
        <EncounterNotices entry={entry} state={state} session={session} />
      </View>
      {hint === null ? null : <View style={[styles.hint, { bottom: metrics.bottom + 72 }]}>{hint}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: content.paper },
  more: { gap: spacing[3], alignItems: 'flex-start' },
  origin: { alignItems: 'flex-start', paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
  notices: { position: 'absolute', top: spacing[2] },
  hint: { position: 'absolute', left: spacing[4], right: spacing[4] },
});
