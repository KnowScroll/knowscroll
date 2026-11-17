import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type StyleProp,
  type ViewInstance,
  type ViewStyle,
} from 'react-native';
import { layout, spacing } from '@knowscroll/design-tokens';
import { dataSet } from '../../display/data-set';
import { useDisplay } from '../../display/display';
import { useFocusRing } from '../../display/focus-ring';
import { scrollPageSurface } from '../../display/scroll-page-surface';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import { useArticleActivity } from '../reading/use-activity';
import { useReadingViewport } from '../reading/reading-viewport';
import type { ReadingViewport, UnitReadingObserver } from '../reading/types';
import type { NextPartPeek, PartArrival, ReaderCommands, ReaderHandle } from '../reader/reader-commands';
import { run } from '../reader/reader-commands';
import { ReaderFocus } from '../reader/reader-focus';
import { SelectionMenu } from '../reader/selection-menu';
import { passageOf } from '../reader/passage';
import { useBeatReading } from './beat-reading';
import { BeatView } from './beat-view';
import { EndPlateView } from './end-plate';
import { canPinHolds, figureHeightFor, holdsBeside, isWide, readingBandOf } from './essay-layout';
import { FigureView } from './figure-view';
import { folioKeyOf, type FolioKey } from './folio-keys';
import { HoldView } from './hold-view';
import { beatsOf, type Beat, type FigureControl, type ReadingModel } from './reading-model';
import type { FigureState } from '../stage/kit-figure';
import { createKeptPlace } from './kept-place';
import { usePersonInput } from './person-input';
import { createPlaces, type Places } from './places';
import { createScrollOffset, type ScrollOffset } from './scroll-offset';

export interface FolioReaderProps {
  readonly model: ReadingModel;
  readonly observer?: UnitReadingObserver | undefined;
  /** An overlay holds the reader: reading time stops counting. */
  readonly paused?: boolean | undefined;
  /** The stop to open at (a kept place, a shared moment). */
  readonly initialStopId?: string | undefined;
  readonly handleRef?: Ref<ReaderHandle> | undefined;
  /** The stop being read changed; `undefined` at the end plate. */
  readonly onStopChange?: ((stopId: string | undefined) => void) | undefined;
  readonly header?: ReactNode;
  readonly dock?: ReactNode;
  readonly commands: ReaderCommands;
  readonly nextPart?: NextPartPeek | undefined;
  readonly previousPart?: NextPartPeek | undefined;
  /** Set when this Scroll was opened by a move to the next Part: says the place in the one left is kept. */
  readonly arrival?: PartArrival | undefined;
  /** A note over the top of the page, below the header (Explore's "Next topic" note). */
  readonly topNote?: ReactNode;
  readonly onDone?: (() => void) | undefined;
  readonly endSlot?: ReactNode;
  /** What the screen draws under a beat (a Quick answer card). */
  readonly stopFooter?: ((stopId: string) => ReactNode) | undefined;
}

/** The place of the end plate among the beats'. */
const END = 'end';
/** How long the arrival note stays: long enough to read, short enough not to sit on the text. */
const ARRIVAL_MS = 4_000;

/** How long after opening a kept place is held while the page settles, unless the person scrolls first. */
const RESTORE_MS = 4_000;

/** The beat being read: the last one whose top has reached the top of the reading band. */
function beatAtLine(order: readonly Beat[], places: Places, line: number): string | undefined {
  let reading = order[0]?.id;
  for (const beat of order) {
    const top = places.topOf(beat.id);
    if (top !== undefined && top <= line) reading = beat.id;
  }
  return reading;
}

function hasTextVersion(model: ReadingModel): boolean {
  return (
    model.end.figure !== undefined ||
    model.sections.some((section) =>
      section.blocks.some(
        (block) => block.kind !== 'beat' || block.beat.play !== undefined || block.beat.guide !== undefined,
      ),
    )
  );
}

/**
 * The Folio reader (folio README 5): a Scroll as an essay in one scrolling column, with figures set after the beats that
 * change them and a figure that holds while the beats about it pass. It draws a `ReadingModel`, whatever document made
 * it. It reports what is read by beat id through the article's measuring hooks, in a band of the viewport
 * (`readingBandOf`), and takes the same commands and handle as every reader, so the screens that host it wire nothing
 * new. Nothing scrolls sideways: Parts and the next idea are buttons and keys.
 */
export function FolioReader({
  model,
  observer,
  paused = false,
  initialStopId,
  handleRef,
  onStopChange,
  header,
  dock,
  commands,
  nextPart,
  previousPart,
  arrival,
  topNote,
  onDone,
  endSlot,
  stopFooter,
}: FolioReaderProps) {
  const { reducedMotion, breakpoint, textScale } = useDisplay();
  const wide = isWide(breakpoint);
  const [readerWidth, setReaderWidth] = useState(0);
  const beside = holdsBeside(readerWidth);
  const page = usePagePalette();
  const [viewportHeight, setViewportHeight] = useState(0);
  const band = useMemo(() => readingBandOf(viewportHeight), [viewportHeight]);
  const viewport = useReadingViewport(observer, band);
  useArticleActivity(observer, paused);
  const [offset] = useState(createScrollOffset);
  const scroller = useRef<ScrollViewInstance>(null);
  const contentHeight = useRef(0);
  const order = useMemo(() => beatsOf(model), [model]);
  const [places] = useState(createPlaces);
  // A kept place opens where it was left. The page settles over several frames (holds measure themselves, figures draw),
  // so the place is held until the person scrolls or the page has had time to settle; until then it is what is being read.
  // A place kept from another revision, or a mistyped anchor, names no beat here: the essay opens at its start instead,
  // so nothing the screen keeps or asks about can name a stop this document does not have.
  const [startStop] = useState(() => order.find((beat) => beat.id === initialStopId)?.id);
  const [kept] = useState(() => createKeptPlace(startStop !== undefined));
  const [reading, setReading] = useState<string | undefined>(startStop ?? order[0]?.id);
  const [atEnd, setAtEnd] = useState(false);
  const [textVersion, setTextVersion] = useState(false);
  const [simpler, setSimpler] = useState<ReadonlySet<string>>(new Set());
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(
    () => new Set(order.flatMap((beat) => beat.notes.filter((note) => !note.collapsed).map((note) => note.id))),
  );
  const figureHeight = figureHeightFor(viewportHeight, beside);
  // With every picture as its words, a figure is as tall as its words and nothing needs to stay in view: holds lie flat.
  const pinHolds = !textVersion && canPinHolds(viewportHeight, figureHeight, beside, textScale);

  // The beat being read follows the scroll; the screen hears of it only when it changes.
  useEffect(
    () =>
      offset.subscribe(() => {
        if (kept.holding()) return;
        const { top, viewport: height } = offset.current();
        const line = top + readingBandOf(height).top;
        setReading(beatAtLine(order, places, line));
        // The end: the end plate reached the reading line, or the page can scroll no further (a short end plate on a tall
        // screen never reaches the line).
        const bottom = top + height >= contentHeight.current - 2;
        setAtEnd(line >= (places.topOf(END) ?? Infinity) || (bottom && top > 0));
      }),
    [kept, offset, order, places],
  );
  useEffect(() => {
    onStopChange?.(atEnd ? undefined : reading);
  }, [reading, atEnd, onStopChange]);

  /**
   * Where a stop is brought to: its top at the top of the reading band, so the stop opened is the stop being read, a held
   * figure (which pins above the band) shows its state, and the end of the beat before it is still in view.
   */
  const targetOf = useCallback(
    (stopId: string): number | undefined => {
      const top = places.topOf(stopId);
      return top === undefined ? undefined : top - readingBandOf(offset.current().viewport).top + 1;
    },
    [places, offset],
  );

  useEffect(() => {
    const timer = setTimeout(kept.release, RESTORE_MS);
    return () => clearTimeout(timer);
  }, [kept]);
  const restore = useCallback(() => {
    if (!kept.holding() || startStop === undefined) return;
    // The reading band is a share of the viewport: until the scroller has a height, there is no place to put the beat.
    if (offset.current().viewport <= 0) return;
    const target = targetOf(startStop);
    if (target === undefined) return;
    const y = Math.max(0, target);
    if (kept.ask(y, offset.current().top)) scroller.current?.scrollTo({ y, animated: false });
  }, [kept, offset, startStop, targetOf]);
  const placeBeat = useCallback(
    (beatId: string, top: number) => {
      places.laidOut(beatId, top);
      restore();
    },
    [places, restore],
  );

  const scrollTo = useCallback(
    (y: number) => {
      const most = Math.max(0, contentHeight.current - offset.current().viewport);
      scroller.current?.scrollTo({ y: Math.min(most, Math.max(0, y)), animated: !reducedMotion });
    },
    [offset, reducedMotion],
  );
  const toggleSimpler = useCallback(
    (beatId: string) =>
      setSimpler((all) => {
        const next = new Set(all);
        if (!next.delete(beatId)) next.add(beatId);
        return next;
      }),
    [setSimpler],
  );
  const readBeat = order.find((beat) => beat.id === reading);
  const textVersionShown = hasTextVersion(model);
  useImperativeHandle(
    handleRef,
    () => ({
      capture: () => (atEnd || reading === undefined ? undefined : { stopId: reading }),
      jumpToStop: (stopId) => {
        kept.release();
        const target = targetOf(stopId);
        if (target !== undefined) scrollTo(target);
      },
      toggleSimpler: () => {
        if (atEnd || readBeat?.simple === undefined) return false;
        toggleSimpler(readBeat.id);
        return true;
      },
      toggleTextVersion: () => {
        if (!textVersionShown) return false;
        setTextVersion((now) => !now);
        return true;
      },
      view: () => ({
        simplerStopId: atEnd || readBeat?.simple === undefined ? undefined : readBeat.id,
        simplerOn: readBeat !== undefined && simpler.has(readBeat.id),
        hasTextVersion: textVersionShown,
        textVersionOn: textVersion,
      }),
    }),
    [atEnd, kept, reading, readBeat, scrollTo, simpler, targetOf, textVersion, textVersionShown, toggleSimpler],
  );

  const onKey = (key: FolioKey): boolean => {
    // A key the person presses is their own input: a place kept at the opening has done its job.
    kept.release();
    const { top, viewport: height } = offset.current();
    switch (key.action) {
      case 'next-stop':
        scrollTo(top + height * 0.3);
        return true;
      case 'previous-stop':
        scrollTo(top - height * 0.3);
        return true;
      case 'page-down':
        scrollTo(top + height * 0.85);
        return true;
      case 'page-up':
        scrollTo(top - height * 0.85);
        return true;
      case 'to-start':
        scrollTo(0);
        return true;
      case 'to-end':
        // The scroller's own end, not the last height it reported: right after the text version changes, the essay is
        // still reflowing and that height is behind.
        scroller.current?.scrollToEnd({ animated: !reducedMotion });
        return true;
      case 'next-part':
        return run(commands.wayOn);
      case 'previous-part':
        return run(commands.previousPart);
      case 'next-topic':
        return run(commands.nextTopic);
      case 'universe':
        return run(commands.universe);
      case 'ask':
        return run(commands.ask);
      case 'format':
        return run(commands.format);
      case 'save':
        return run(commands.save);
      case 'share-moment':
        return run(commands.shareMoment);
      case 'challenge':
        return run(commands.challenge);
      case 'small-print':
        return run(commands.smallPrint);
      case 'report':
        return run(commands.report);
      case 'undo':
        return run(commands.undo);
      case 'simpler':
        if (readBeat?.simple === undefined) return false;
        toggleSimpler(readBeat.id);
        return true;
      case 'text-version':
        if (!textVersionShown) return false;
        setTextVersion((now) => !now);
        return true;
    }
  };

  const onScrollEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement } = event.nativeEvent;
      offset.update(contentOffset.y, layoutMeasurement.height);
      viewport.scrollProps.onScroll?.(event);
    },
    [offset, viewport],
  );
  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: offset.animated } } }], {
        // Native moves a held figure on the UI thread; the browser pins it with CSS.
        useNativeDriver: Platform.OS !== 'web',
        listener: onScrollEvent,
      }),
    [offset, onScrollEvent],
  );
  // The person's own input lets a kept place go; the page moving under it never does.
  const releaseKept = useCallback(() => kept.release(), [kept]);
  usePersonInput(scroller, releaseKept);
  const onScrollBeginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    kept.release();
    viewport.scrollProps.onScrollBeginDrag?.(event);
  };
  const onLayout = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setViewportHeight(height);
    offset.update(offset.current().top, height);
    // Beats may have been placed before the scroller had a height (a slow first layout): place the kept beat now.
    restore();
    viewport.scrollProps.onLayout?.(event);
  };

  const askAbout = (stopId: string, selected: string) => {
    const passage = passageOf(selected);
    if (passage !== '') commands.askAbout?.(stopId, passage);
  };
  const measure = wide ? (breakpoint === 'desktop' ? layout.measureDesktop : layout.measureTablet) : undefined;
  const column = measure === undefined ? styles.column : [styles.column, { maxWidth: measure }];
  // A hold beside its beats needs room for both: the column and the figure's share of the screen.
  const holdColumn = !beside || measure === undefined ? column : [styles.column, { maxWidth: measure * 1.45 }];
  // A beat's wrapper is measured, so it must be a direct child of the essay's content (or of a hold, which says where it is).
  const renderBeat = (
    beat: Beat,
    held?: { quiet: boolean; figureWords: string | undefined; contentTop: number | undefined },
  ) => (
    <MeasuredBeat
      key={beat.id}
      viewport={viewport}
      beat={beat}
      contentTop={held === undefined ? 0 : held.contentTop}
      places={places}
      onTop={placeBeat}
      style={held === undefined ? column : undefined}
    >
      <BeatView
        beat={beat}
        textVersion={textVersion}
        simpler={simpler.has(beat.id)}
        onToggleSimpler={toggleSimpler}
        openNotes={openNotes}
        onToggleNote={(noteId) =>
          setOpenNotes((all) => {
            const next = new Set(all);
            if (!next.delete(noteId)) next.add(noteId);
            return next;
          })
        }
        quiet={held?.quiet}
        figureWords={held?.figureWords}
        footer={stopFooter?.(beat.id)}
      />
    </MeasuredBeat>
  );
  const renderFigure = (id: string, figure: FigureState, control?: FigureControl) => (
    <View key={id} style={column}>
      <FigureView
        figure={figure}
        control={control}
        height={figureHeight}
        reducedMotion={reducedMotion}
        textVersion={textVersion}
        testID={`figure-${id}`}
      />
    </View>
  );
  return (
    <ReaderFocus keyOf={folioKeyOf} onKey={onKey}>
      {header}
      <ProgressRail offset={offset} contentHeight={contentHeight} />
      <View
        style={[styles.page, { backgroundColor: page.ground }]}
        onLayout={(event) => setReaderWidth(event.nativeEvent.layout.width)}
        testID="folio-page"
        {...scrollPageSurface()}
      >
        <Animated.ScrollView
          ref={scroller}
          testID="folio-scroller"
          style={styles.scroller}
          contentContainerStyle={styles.content}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onLayout={onLayout}
          onContentSizeChange={(width, height) => {
            contentHeight.current = height;
            restore();
            viewport.scrollProps.onContentSizeChange?.(width, height);
          }}
          onScrollBeginDrag={onScrollBeginDrag}
        >
          <View style={[column, styles.opening]}>
            {previousPart === undefined ? null : <PreviousPartLink previous={previousPart} />}
            <Text variant="label" color={page.link}>
              {model.kicker}
            </Text>
            <Text variant="page" heading={1} color={page.ink}>
              {model.title}
            </Text>
            <Text variant="bodyS" color={page.ink2}>
              {model.dek}
            </Text>
          </View>
          {model.sections.flatMap((section) => [
            section.heading === undefined ? null : (
              <View key={`heading-${section.id}`} style={column}>
                <Text variant="heading" heading={2} color={page.ink}>
                  {section.heading}
                </Text>
              </View>
            ),
            ...section.blocks.flatMap((block) => {
              if (block.kind === 'beat') return [renderBeat(block.beat)];
              if (block.kind === 'figure') {
                return [renderFigure(block.id, block.figure, block.control)];
              }
              // Where a pinned figure would leave no room to read, or the pictures are words, a hold is drawn as beats each
              // followed by its figure.
              if (!pinHolds) {
                return block.beats.flatMap((held, index) =>
                  held.figure.key === block.beats[index - 1]?.figure.key
                    ? [renderBeat(held.beat)]
                    : [renderBeat(held.beat), renderFigure(`${block.id}-${held.beat.id}`, held.figure)],
                );
              }
              return [
                <HoldView
                  key={block.id}
                  style={holdColumn}
                  hold={block}
                  offset={offset}
                  beside={beside}
                  figureHeight={figureHeight}
                  viewportHeight={viewportHeight}
                  reducedMotion={reducedMotion}
                  textVersion={textVersion}
                  renderBeat={renderBeat}
                  places={places}
                />,
              ];
            }),
          ])}
          <View
            ref={(node) => places.attached(END, node)}
            style={column}
            onLayout={(event) => places.laidOut(END, event.nativeEvent.layout.y)}
            {...dataSet({ ksStop: 'end', ksKind: 'end' })}
          >
            <EndPlateView
              end={model.end}
              figureHeight={figureHeight}
              reducedMotion={reducedMotion}
              textVersion={textVersion}
              nextPart={nextPart}
              onClose={onDone}
              onNextIdea={commands.nextTopic}
              endSlot={endSlot}
            />
          </View>
        </Animated.ScrollView>
        {arrival === undefined ? null : <ArrivalNote arrival={arrival} />}
        {topNote === undefined ? null : (
          <View style={styles.topNote} pointerEvents="box-none">
            {topNote}
          </View>
        )}
      </View>
      <SelectionMenu onSimpler={toggleSimpler} onAsk={commands.askAbout === undefined ? undefined : askAbout} />
      {dock}
    </ReaderFocus>
  );
}

/** A beat wrapped so the reading viewport measures it and the reader knows where it starts. */
function MeasuredBeat({
  viewport,
  beat,
  contentTop,
  places,
  onTop,
  style,
  children,
}: {
  readonly viewport: ReadingViewport;
  readonly beat: Beat;
  readonly places: Places;
  /** Where the beat's slot starts in the essay; `undefined` while it is not known (a hold not yet laid out). */
  readonly contentTop: number | undefined;
  readonly onTop: (beatId: string, top: number) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  const { onLayout: onReadingLayout, ref: readingRef } = useBeatReading(viewport, beat.id, contentTop);
  const ref = useCallback(
    (node: ViewInstance | null) => {
      readingRef?.(node);
      places.attached(beat.id, node);
    },
    [readingRef, places, beat.id],
  );
  // A held beat learns where its hold is after its own layout: say where it starts again when that moves.
  const ownTop = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (ownTop.current !== undefined && contentTop !== undefined) onTop(beat.id, contentTop + ownTop.current);
  }, [beat.id, contentTop, onTop]);
  return (
    <View
      ref={ref}
      style={style}
      onLayout={(event) => {
        onReadingLayout?.(event);
        ownTop.current = event.nativeEvent.layout.y;
        if (contentTop !== undefined) onTop(beat.id, contentTop + event.nativeEvent.layout.y);
      }}
      {...dataSet({ ksStop: beat.id, ksKind: beat.kind === 'prose' ? 'read' : 'call' })}
    >
      {children}
    </View>
  );
}

/** How far through the essay the reader is: a thin bar under the header (folio README 5.2, the rail). */
function ProgressRail({
  offset,
  contentHeight,
}: {
  readonly offset: ScrollOffset;
  readonly contentHeight: { readonly current: number };
}) {
  const page = usePagePalette();
  const [progress, setProgress] = useState(0);
  useEffect(
    () =>
      offset.subscribe(() => {
        const { top, viewport } = offset.current();
        const travel = contentHeight.current - viewport;
        const next = travel > 0 ? Math.min(1, Math.max(0, top / travel)) : 0;
        setProgress((was) => (Math.abs(was - next) < 0.01 ? was : next));
      }),
    [offset, contentHeight],
  );
  return (
    <View
      style={[styles.rail, { backgroundColor: page.rule }]}
      role="progressbar"
      aria-label="How far you have read"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      testID="folio-progress"
    >
      <View style={[styles.railFill, { width: `${String(progress * 100)}%`, backgroundColor: page.link }]} />
    </View>
  );
}

function PreviousPartLink({ previous }: { readonly previous: NextPartPeek }) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`${previous.label}: ${previous.title}`}
      onPress={previous.onPress}
      style={[styles.previous, focus.style]}
      testID="folio-previous-part"
    >
      <Text variant="uiS" color={page.link}>{`← ${previous.label}`}</Text>
    </Pressable>
  );
}

function ArrivalNote({ arrival }: { readonly arrival: PartArrival }) {
  const page = usePagePalette();
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), ARRIVAL_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <View
      style={[styles.arrival, { backgroundColor: page.ink }]}
      role="status"
      pointerEvents="none"
      testID="folio-arrival"
    >
      <Text variant="uiS" color={page.ground}>{`${arrival.part} · your place in ${arrival.from} is kept`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, overflow: 'hidden' },
  scroller: { flex: 1 },
  content: { paddingHorizontal: layout.gutter, paddingBottom: spacing[12], gap: spacing[6], alignItems: 'center' },
  column: { width: '100%' },
  opening: { gap: spacing[2], paddingTop: spacing[6] },
  rail: { height: 3, width: '100%' },
  railFill: { height: 3 },
  previous: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  arrival: {
    position: 'absolute',
    top: spacing[2],
    alignSelf: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: 999,
  },
  topNote: { position: 'absolute', top: spacing[2], left: spacing[4], right: spacing[4] },
});
