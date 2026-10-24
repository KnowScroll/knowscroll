import { useCallback, type ComponentRef, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import type { ScrollLocalPosition, ScrollPositionHandle } from '@knowscroll/ui';
import { ActivatedScrollView } from '../scroll/activated-scroll-view';
import { EncounterStrip } from './encounter-actions';
import type { EncounterEntry } from './encounter-history';
import { useEncounterMetrics } from './encounter-metrics';
import { EncounterNotices } from './encounter-notices';
import type { EncounterSession, EncounterState } from './encounter-session';
import { EncounterTopBar } from './encounter-top-bar';
import { ScrollEnd } from './scroll-end';

type ScrollEntry = Extract<EncounterEntry, { kind: 'scroll' }>;

/** Past this many pixels into the first block the opening's action row has scrolled away. */
const OPENING_OFFSET = 160;

/**
 * A Scroll as drawn in E02: Back and the format switch above the article, the same action set as
 * the Reel under the opening and floating once the article is underway, and the end of the
 * article as a boundary. Vertical reading never navigates (blueprint §18).
 */
export function ScrollEncounter({
  scope,
  entry,
  state,
  session,
  foreground,
  back,
  hint,
}: {
  readonly scope: AccountScope;
  readonly entry: ScrollEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly foreground: boolean;
  readonly back: () => void;
  readonly hint: ReactNode;
}) {
  const metrics = useEncounterMetrics();
  const scrollPosition = useRef<ScrollPositionHandle>(null);
  const playable = foreground && !state.overlay && state.phase === 'active';
  const [underway, setUnderway] = useState(false);
  const endCard = useRef<ComponentRef<typeof View>>(null);
  const { height: windowHeight } = useWindowDimensions();
  const firstBlockId = entry.scroll.document.sections[0]?.blocks[0]?.id;
  const lastBlockId = entry.scroll.document.sections.at(-1)?.blocks.at(-1)?.id;
  const onPositionChange = useCallback(
    (position: ScrollLocalPosition) => {
      // Underway: past the opening, which holds its own action row.
      const pastOpening = position.blockId !== firstBlockId || position.offsetWithinBlock > OPENING_OFFSET;
      // The end card holds another row, so the floating one gives way as soon as any of it is on screen.
      endCard.current?.measureInWindow((_x, top, _width, height) => {
        const endVisible = height > 0 && top < windowHeight - metrics.bottom;
        setUnderway(pastOpening && !endVisible);
      });
      if (endCard.current === null) setUnderway(pastOpening && position.blockId !== lastBlockId);
    },
    [firstBlockId, lastBlockId, windowHeight, metrics.bottom],
  );
  useLayoutEffect(() => {
    if (!playable) return;
    session.bindSurface(entry, {
      capture: () => {
        const value = scrollPosition.current?.capture();
        return value ? { kind: 'scroll', value } : undefined;
      },
      pause: () => undefined,
    });
    session.mount(entry);
    return () => session.park(entry);
  }, [entry, session, playable]);
  return (
    <View style={styles.page}>
      <View style={[styles.top, { paddingTop: metrics.top, paddingHorizontal: metrics.side }]}>
        <EncounterTopBar entry={entry} session={session} surface="paper" back={back} />
      </View>
      <View style={styles.article}>
        <ActivatedScrollView
          scope={scope}
          scroll={entry.scroll}
          observer={entry.recorder.observer}
          positionRef={scrollPosition}
          initialPosition={entry.position?.kind === 'scroll' ? entry.position.value : undefined}
          onPositionChange={onPositionChange}
          paused={!playable}
          topInset={spacing[3]}
          bottomInset={metrics.bottom + spacing[6]}
          readingBottomInset={metrics.bottom}
          afterHeader={<EncounterStrip entry={entry} state={state} session={session} align="start" />}
          endSlot={<ScrollEnd entry={entry} state={state} session={session} innerRef={endCard} />}
        />
        <View style={[styles.notices, { left: metrics.side, right: metrics.side }]} pointerEvents="box-none">
          <EncounterNotices entry={entry} state={state} session={session} />
        </View>
        {underway ? (
          <View
            testID="encounter-floating-actions"
            style={[styles.floating, { right: metrics.side, bottom: metrics.bottom + spacing[2] }]}
            pointerEvents="box-none"
          >
            <EncounterStrip entry={entry} state={state} session={session} />
          </View>
        ) : null}
        {hint === null ? null : <View style={[styles.hint, { bottom: metrics.bottom + spacing[2] }]}>{hint}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: content.paper },
  top: { paddingBottom: spacing[2], backgroundColor: content.paper },
  article: { flex: 1, minHeight: 0 },
  notices: { position: 'absolute', top: spacing[2] },
  floating: { position: 'absolute' },
  hint: { position: 'absolute', left: spacing[4], right: spacing[4] },
});
