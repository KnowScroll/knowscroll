import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { borderWidth, layout, spacing } from '@knowscroll/design-tokens';
import { usePagePalette } from '../page/page-palette';
import { FigureView } from './figure-view';
import { heldBeatAt, readingLineOf } from './hold-geometry';
import { PinnedFigure } from './pinned-figure';
import type { Beat, HoldBlock } from './reading-model';
import type { Places } from './places';
import type { ScrollOffset } from './scroll-offset';

/** How the reader draws one beat inside a hold. */
export type RenderHeldBeat = (
  beat: Beat,
  held: {
    readonly quiet: boolean;
    readonly figureWords: string | undefined;
    /** Where the beat's slot starts in the essay; `undefined` until the hold and the slot have been laid out. */
    readonly contentTop: number | undefined;
  },
) => ReactNode;

/** Room under each held beat, as a share of the viewport, so each one is read while the figure shows its state. */
const BEAT_ROOM = 0.18;

/** The beat of the hold the figure shows now, following the scroll. A beat not yet placed has not been reached. */
function useShownBeat(offset: ScrollOffset, places: Places, beatIds: readonly string[], pinnedHeight: number): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const update = () => {
      const { top, viewport } = offset.current();
      const tops = beatIds.map((beatId) => places.topOf(beatId) ?? Infinity);
      setShown(heldBeatAt(tops, top + readingLineOf(viewport, pinnedHeight)));
    };
    update();
    return offset.subscribe(update);
  }, [offset, places, beatIds, pinnedHeight]);
  return shown;
}

/**
 * A figure that holds while two or three beats pass (folio README 5.3, 5.6). On a phone it pins at the top of the
 * viewport above the beats; where the reader is wide enough it pins beside them. As each beat reaches the reading line the figure
 * moves to that beat's state, and when the hold ends the figure scrolls away with it. The figure's state follows the
 * scroll, which a screen-reader user does not produce, so each beat after the first also carries the figure's words.
 */
export function HoldView({
  hold,
  offset,
  beside,
  figureHeight,
  viewportHeight,
  reducedMotion,
  textVersion,
  renderBeat,
  places,
  style,
}: {
  readonly hold: HoldBlock;
  readonly offset: ScrollOffset;
  /** Where each beat starts in the essay (`places.ts`): the figure shows the last beat to reach the reading line. */
  readonly places: Places;
  readonly beside: boolean;
  readonly figureHeight: number;
  readonly viewportHeight: number;
  readonly reducedMotion: boolean;
  readonly textVersion: boolean;
  readonly renderBeat: RenderHeldBeat;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const page = usePagePalette();
  const [holdBox, setHoldBox] = useState({ top: 0, height: 0 });
  const [pinnedHeight, setPinnedHeight] = useState(figureHeight);
  const [columnTop, setColumnTop] = useState(0);
  const [beatTops, setBeatTops] = useState<readonly number[]>([]);
  const beatIds = useMemo(() => hold.beats.map((held) => held.beat.id), [hold]);
  const shown = useShownBeat(offset, places, beatIds, beside ? 0 : pinnedHeight);
  const current = hold.beats[Math.min(shown, hold.beats.length - 1)] ?? hold.beats[0];
  const placeBeat = (index: number) => (event: LayoutChangeEvent) => {
    const { y } = event.nativeEvent.layout;
    setBeatTops((tops) => {
      if (tops[index] === y) return tops;
      const next = [...tops];
      next[index] = y;
      return next;
    });
  };
  if (current === undefined) return null;
  const room = Math.round(viewportHeight * BEAT_ROOM);
  // Beside the text, the figure pins when the hold reaches the top: the beats start at the reading line, so the first is
  // read while the figure pins, and the column runs on far enough for the last to be read before the figure lets go.
  const line = readingLineOf(viewportHeight, 0);
  const columnRoom = beside
    ? { paddingTop: line, paddingBottom: Math.max(room, room + pinnedHeight - line) }
    : { paddingBottom: room };
  return (
    <View
      style={[style, beside ? styles.beside : styles.narrow]}
      testID={`hold-${hold.id}`}
      onLayout={(event) => setHoldBox({ top: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height })}
    >
      <PinnedFigure
        offset={offset}
        holdTop={holdBox.top}
        travel={Math.max(0, holdBox.height - pinnedHeight)}
        style={[
          beside ? styles.figureBeside : styles.figureNarrow,
          { backgroundColor: page.ground, borderBottomColor: beside ? undefined : page.rule },
        ]}
      >
        <View onLayout={(event) => setPinnedHeight(event.nativeEvent.layout.height)}>
          <FigureView
            figure={current.figure}
            height={figureHeight}
            reducedMotion={reducedMotion}
            textVersion={textVersion}
            fixedHeight
            testID="held-figure"
          />
        </View>
      </PinnedFigure>
      <View style={[styles.column, columnRoom]} onLayout={(event) => setColumnTop(event.nativeEvent.layout.y)}>
        {hold.beats.map((held, index) => (
          <View
            key={held.beat.id}
            onLayout={placeBeat(index)}
            style={index < hold.beats.length - 1 ? { marginBottom: room } : null}
          >
            {renderBeat(held.beat, {
              quiet: index !== shown,
              figureWords: index === 0 ? undefined : held.figure.alt,
              contentTop:
                holdBox.height > 0 && beatTops[index] !== undefined
                  ? holdBox.top + columnTop + beatTops[index]
                  : undefined,
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  narrow: { gap: spacing[4] },
  beside: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: spacing[8] },
  // Pinned on a phone, the figure is a panel the width of the screen, edged below, so the text passing under it reads
  // as going under, not as cut off.
  figureNarrow: {
    marginHorizontal: -layout.gutter,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
    borderBottomWidth: borderWidth.regular,
  },
  figureBeside: { flexBasis: '46%', flexGrow: 0, flexShrink: 0, alignSelf: 'flex-start', paddingTop: spacing[4] },
  column: { flex: 1, minWidth: 0, gap: spacing[4] },
});
