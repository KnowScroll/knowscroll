import { useState, type ReactNode, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  BottomSheet,
  ReaderDock,
  ReaderTopBar,
  StageReader,
  useDisplay,
  type NextPartPeek,
  type StageReaderHandle,
  type StageReadingObserver,
} from '@knowscroll/ui';
import type { OpenedStageScroll } from './scroll-session';
import { useStagePlay } from './use-stage-play';

/** What the surface needs from the screen it is on: where each move goes. Each is also a gesture and a key in the reader. */
export interface StageMoves {
  readonly universe: () => void;
  readonly nextTopic?: (() => void) | undefined;
  readonly nextPart?: NextPartPeek | undefined;
  /** Another angle on the idea. With no next Part it is the way on (the dock, the → key, a swipe left) (D-184). */
  readonly related?: NextPartPeek | undefined;
  readonly previousPart?: (() => void) | undefined;
  readonly ask?: (() => void) | undefined;
  /** The Reel/Scroll switch; `format` is the key that moves to the other format. */
  readonly formatSwitch?: ReactNode;
  readonly format?: (() => void) | undefined;
  readonly done?: (() => void) | undefined;
}

/**
 * One Stage + Spine reader for a v2 Scroll, wherever it is shown (the Explore encounter and the
 * direct `/scroll/<id>` route): its top bar, the reader, its dock and the ••• sheet, with the room a
 * screen keeps for the status bar and the tab bar. The screen supplies the moves and what the sheet
 * holds (Save, Share), because those differ by screen. Play (the calls, the sparks in the dock) belongs
 * to the Scroll, so it is the same on both. On a tablet or desktop the reader is a
 * centred column with the stage pinned at its top (D-133).
 */
export function StageReaderSurface({
  scroll,
  observer,
  paused,
  initialStopId,
  handleRef,
  onStopChange,
  moves,
  partLabel,
  moreBody,
  headerNote,
  topInset,
  bottomInset,
}: {
  readonly scroll: OpenedStageScroll;
  readonly observer?: StageReadingObserver | undefined;
  readonly paused?: boolean | undefined;
  readonly initialStopId?: string | undefined;
  readonly handleRef?: Ref<StageReaderHandle> | undefined;
  readonly onStopChange?: ((stopId: string | undefined) => void) | undefined;
  readonly moves: StageMoves;
  /** "Part 1 of 3": a count only when the server counted it. */
  readonly partLabel?: string | undefined;
  /** What the ••• sheet holds, given a way to close it; without it there is no ••• button. */
  readonly moreBody?: ((close: () => void) => ReactNode) | undefined;
  /** A line under the top bar (where the person came from). */
  readonly headerNote?: ReactNode;
  readonly topInset: number;
  readonly bottomInset: number;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { breakpoint } = useDisplay();
  const { document } = scroll;
  // Play on this Scroll: the person's own calls, sparks and combo, kept unless recording is paused (D-063, D-083).
  const play = useStagePlay(scroll);
  const wayOn = moves.nextPart ?? moves.related;
  return (
    <View style={styles.page}>
      <View style={[styles.column, breakpoint === 'compact' ? null : styles.wide]}>
        <StageReader
          document={document}
          observer={observer}
          paused={paused === true || moreOpen}
          initialStopId={initialStopId}
          handleRef={handleRef}
          onStopChange={onStopChange}
          nextPart={moves.nextPart}
          related={moves.related}
          onDone={moves.done}
          play={play}
          commands={{
            universe: moves.universe,
            ask: moves.ask,
            format: moves.format,
            nextPart: wayOn?.onPress,
            previousPart: moves.previousPart,
            nextTopic: moves.nextTopic,
          }}
          header={
            <View style={{ paddingTop: topInset }}>
              <ReaderTopBar
                title={document.title}
                kicker={document.kicker}
                partLabel={partLabel}
                formatSwitch={moves.formatSwitch}
                onUniverse={moves.universe}
                onNextTopic={moves.nextTopic}
              />
              {headerNote}
            </View>
          }
          dock={
            <View style={{ paddingBottom: bottomInset }}>
              <ReaderDock
                onAsk={moves.ask}
                sparks={play?.sparks}
                onMore={moreBody === undefined ? undefined : () => setMoreOpen(true)}
                nextPart={wayOn}
              />
            </View>
          }
        />
      </View>
      {moreBody === undefined ? null : (
        <BottomSheet visible={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
          {moreBody(() => setMoreOpen(false))}
        </BottomSheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: content.paper, alignItems: 'center' },
  column: { flex: 1, minHeight: 0, width: '100%' },
  wide: { maxWidth: layout.measureDesktop + 2 * layout.gutter + spacing[8] },
});
