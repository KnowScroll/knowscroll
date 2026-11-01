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
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewInstance } from 'react-native';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { AXIAL_TILT_DEGREES, callsOf, finalBonusReady, type ScrollDocumentV2 } from '../model';
import { toggleSemantics } from '../../display/semantics';
import { useDisplay } from '../../display/display';
import { useFocusRing } from '../../display/focus-ring';
import { Text } from '../../text/text';
import { Stage } from '../stage';
import type { FinalCallPlay } from './call-view';
import type { NextPartPeek, SmallPrint } from './end-tray';
import type { PartMove } from './part-gesture';
import { PartSwipe } from './part-swipe';
import { payoffOf } from './payoff';
import { passageOf } from './passage';
import { SelectionMenu } from './selection-menu';
import { actOnKey, run, type ReaderCommands } from './reader-actions';
import { ReaderFocus } from './reader-focus';
import type { ReaderKey } from './reader-keys';
import { Spine, type SpineDot } from './spine';
import { lockOf, useLocalStagePlay, type StagePlay } from './stage-play';
import { StopList } from './stop-list';
import { useCallPlay } from './use-call-play';
import { useReaderScroll } from './use-reader-scroll';
import { useStopReading, type StageReadingObserver } from './use-stop-reading';

export type { ReaderCommands } from './reader-actions';

export interface StageReaderHandle {
  /** The stop the reader is on, or `undefined` at the end tray. */
  readonly capture: () => { readonly stopId: string } | undefined;
  readonly jumpToStop: (stopId: string) => void;
  /**
   * Switches the stop the reader is on between its full text and its plainer words ("Simpler (this screen)" in the ••• menu).
   * False when that stop has none to show: a call, or the end.
   */
  readonly toggleSimpler: () => boolean;
}

export interface StageReaderProps {
  readonly document: ScrollDocumentV2;
  readonly observer?: StageReadingObserver | undefined;
  /** An overlay holds the reader: reading time stops counting. */
  readonly paused?: boolean | undefined;
  readonly initialStopId?: string | undefined;
  readonly handleRef?: Ref<StageReaderHandle> | undefined;
  readonly onStopChange?: ((stopId: string | undefined) => void) | undefined;
  readonly header?: ReactNode;
  readonly dock?: ReactNode;
  readonly commands: ReaderCommands;
  readonly nextPart?: NextPartPeek | undefined;
  /** Another angle on the same idea, offered at the end beside the next Part (D-184). */
  readonly related?: NextPartPeek | undefined;
  readonly onDone?: (() => void) | undefined;
  /**
   * Play on this Scroll: what was locked, the sparks, and how to lock another (D-063). The app passes
   * one backed by its play session; without one the reader keeps it on the device alone.
   */
  readonly play?: StagePlay | undefined;
  /** Drawn at the end of the Scroll, before the ways on: what the screen it is read on adds (a thread's finish). */
  readonly endSlot?: ReactNode;
}

const MIN_STAGE = 176;

/** The stage is a third of the screen, never less than a readable picture nor more than a column's worth. */
function stageHeightFor(windowHeight: number, wide: boolean): number {
  return Math.round(Math.min(wide ? 340 : 300, Math.max(MIN_STAGE, windowHeight * 0.34)));
}

/** A picture or a play block has a text version, so the reader's switch and the T key have something to swap. */
function hasTextVersion(document: ScrollDocumentV2): boolean {
  return (
    document.stage !== undefined ||
    document.stops.some((stop) => stop.kind === 'read' && (stop.interactive !== undefined || stop.guide !== undefined))
  );
}

function indexOfStop(stops: ScrollDocumentV2['stops'], stopId: string | undefined): number {
  return stops.findIndex((stop) => stop.id === stopId);
}

/** One dot per stop, shaped by what it is, and one for the end. */
function spineOf(document: ScrollDocumentV2): readonly SpineDot[] {
  const total = document.stops.length;
  const calls = callsOf(document).length;
  let call = 0;
  const dots = document.stops.map((stop, index): SpineDot => {
    if (stop.kind === 'read') return { kind: 'read', label: `Stop ${String(index + 1)} of ${String(total)}` };
    call += 1;
    return stop.kind === 'final_call'
      ? { kind: 'final_call', label: 'Final call' }
      : { kind: 'call_it', label: `Call it ${String(call)} of ${String(calls)}` };
  });
  return [...dots, { kind: 'end', label: 'The end of this Scroll' }];
}

/**
 * The reader of a `scroll-document.v2` (D-133, D-134): a stage pinned at the top that changes as the
 * reader moves from stop to stop, the stops as short screens that settle softly, the dots down the
 * right edge to see where you are and jump, the calls played on the device, and a simple end. The app
 * owns the chrome and the moves (Parts, topics, Ask) and hands them in; every one is also a button, a
 * swipe and a key. What is read is reported to the recorder by stop id (D-135).
 */
export function StageReader({
  document,
  observer,
  paused = false,
  initialStopId,
  handleRef,
  onStopChange,
  header,
  dock,
  commands,
  nextPart,
  related,
  onDone,
  play: appPlay,
  endSlot,
}: StageReaderProps) {
  const { reducedMotion, breakpoint } = useDisplay();
  const { height: windowHeight } = useWindowDimensions();
  const dots = useMemo(() => spineOf(document), [document]);
  const calls = useMemo(() => callsOf(document), [document]);
  const scroller = useRef<ScrollViewInstance>(null);
  const text = useReaderScroll({
    scroller,
    sections: document.stops.length + 1,
    startAt: Math.max(0, indexOfStop(document.stops, initialStopId)),
    reducedMotion,
    onPullPastEnd: commands.nextTopic,
  });
  const { current, jump } = text;
  const activeStopId = current < document.stops.length ? document.stops[current]?.id : undefined;
  const reading = useStopReading(observer, activeStopId, paused);
  const ownPlay = useLocalStagePlay(calls, document.landmark);
  const play = appPlay ?? ownPlay;
  const played = useCallPlay(reading, play);
  const finalCall = calls.find((call) => call.kind === 'final_call');
  const [tilt, setTilt] = useState(AXIAL_TILT_DEGREES);
  const sliderBusyUntil = useRef(0);
  /** A drag on the tilt slider is the slider's: a swipe that ends within a moment of it moves no Part. */
  const onTiltDragging = useCallback((dragging: boolean) => {
    sliderBusyUntil.current = dragging ? Infinity : Date.now() + 400;
  }, []);
  const tiltBound = finalCall?.binding?.kind === 'tilt';
  const final: FinalCallPlay = {
    hasLandmark: document.landmark !== undefined,
    bonusReady: finalBonusReady(play.combo),
    combo: play.combo,
    ...(tiltBound ? { tilt: { value: tilt, onChange: setTilt, onDragging: onTiltDragging } } : {}),
  };
  const aside = document.asides.find((candidate) => candidate.id === document.recap.smallPrintAside);
  const smallPrint: SmallPrint | undefined = aside === undefined ? undefined : { title: aside.title, text: aside.text };
  /** Locks a call and, as its reveal opens below the options, brings the reveal on screen. */
  const lockCall = (callId: string): boolean => {
    const locked = played.lock(callId);
    if (locked) text.revealIn(indexOfStop(document.stops, callId));
    return locked;
  };
  const [textVersion, setTextVersion] = useState(false);
  const [simplerStops, setSimplerStops] = useState<ReadonlySet<string>>(new Set());
  const toggleSimpler = useCallback((stopId: string) => {
    setSimplerStops((all) => {
      const next = new Set(all);
      if (!next.delete(stopId)) next.add(stopId);
      return next;
    });
  }, []);
  /** Words were selected in a stop and asked about: the app opens Ask from here at that stop with the words as a draft (D-244). */
  const askAboutWords = (stopId: string, selected: string) => {
    const passage = passageOf(selected);
    if (passage !== '') commands.askAbout?.(stopId, passage);
  };
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(document.asides.filter((aside) => !aside.collapsed).map((aside) => aside.id)),
  );
  useEffect(() => {
    onStopChange?.(activeStopId);
  }, [activeStopId, onStopChange]);
  useImperativeHandle(
    handleRef,
    () => ({
      capture: () => (activeStopId === undefined ? undefined : { stopId: activeStopId }),
      jumpToStop: (stopId) => jump(indexOfStop(document.stops, stopId), false),
      toggleSimpler: () => {
        const stop = document.stops.find((candidate) => candidate.id === activeStopId);
        if (stop?.kind !== 'read') return false;
        toggleSimpler(stop.id);
        return true;
      },
    }),
    [activeStopId, document.stops, jump, toggleSimpler],
  );

  const toggleAside = (asideId: string) =>
    setOpened((all) => {
      const next = new Set(all);
      if (!next.delete(asideId)) next.add(asideId);
      return next;
    });
  // Stable across renders, so the native swipe responder is built once; it reads the commands as of the drag's end.
  const latestCommands = useRef(commands);
  useEffect(() => {
    latestCommands.current = commands;
  });
  const move = useCallback((part: PartMove) => {
    if (part !== 'next-topic' && Date.now() < sliderBusyUntil.current) return;
    const at = latestCommands.current;
    run(part === 'next-part' ? at.wayOn : part === 'previous-part' ? at.previousPart : at.nextTopic);
  }, []);
  const onKey = (key: ReaderKey): boolean =>
    actOnKey(key, {
      stops: document.stops,
      hasTextVersion: hasTextVersion(document),
      commands,
      jump,
      heading: text.heading,
      toggleTextVersion: () => setTextVersion((now) => !now),
      pick: played.pick,
      lock: lockCall,
    });

  const wide = breakpoint === 'tablet' || breakpoint === 'desktop';
  const stopId = document.stops[Math.min(current, document.stops.length - 1)]?.id ?? '';
  return (
    <ReaderFocus onKey={onKey}>
      {header}
      {document.stage === undefined ? null : (
        <View>
          <Stage
            document={{ stops: document.stops, stage: document.stage }}
            stopId={stopId}
            reducedMotion={reducedMotion}
            textVersion={textVersion}
            tilt={tiltBound && activeStopId === finalCall?.id ? tilt : undefined}
            height={stageHeightFor(windowHeight, wide)}
          />
          <TextVersionSwitch on={textVersion} onPress={() => setTextVersion((now) => !now)} />
        </View>
      )}
      <View style={styles.body}>
        <PartSwipe onMove={move}>
          <ScrollView
            ref={scroller}
            testID="stop-scroller"
            style={styles.scroller}
            contentContainerStyle={styles.content}
            {...text.scrollProps}
          >
            <StopList
              document={document}
              textVersion={textVersion}
              dots={dots}
              calls={calls}
              sectionHeight={text.viewport > 0 ? Math.round(text.viewport * 0.8) : 320}
              measureSection={text.measureSection}
              stateOf={played.stateOf}
              lockOf={(callId) => lockOf(play, callId)}
              onRevealLayout={text.reportReveal}
              paused={play.paused}
              pick={played.pick}
              lock={lockCall}
              opened={opened}
              onToggleAside={toggleAside}
              final={final}
              payoff={payoffOf(calls, play)}
              smallPrint={smallPrint}
              endSlot={endSlot}
              nextPart={nextPart}
              related={related}
              onDone={onDone}
              onNextTopic={commands.nextTopic}
              onUniverse={commands.universe}
              onPlayFinal={
                finalCall === undefined ? undefined : () => jump(indexOfStop(document.stops, finalCall.id), false)
              }
              onChallenge={commands.challenge}
              simplerStops={simplerStops}
              onToggleSimpler={toggleSimpler}
            />
          </ScrollView>
        </PartSwipe>
        <Spine dots={dots} current={current} onJump={(index) => jump(index, false)} />
      </View>
      <SelectionMenu onSimpler={toggleSimpler} onAsk={commands.askAbout === undefined ? undefined : askAboutWords} />
      {dock}
    </ReaderFocus>
  );
}

function TextVersionSwitch({ on, onPress }: { readonly on: boolean; readonly onPress: () => void }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...toggleSemantics(on)}
      accessibilityLabel="Text version"
      onPress={onPress}
      style={[styles.textChip, on ? styles.textChipOn : null, focus.style]}
    >
      <Text variant="monoXs" color={on ? content.paper : content.ink}>
        Text
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minHeight: 0, flexDirection: 'row' },
  scroller: { flex: 1 },
  content: { paddingBottom: spacing[12] },
  textChip: {
    position: 'absolute',
    right: spacing[2],
    bottom: spacing[2],
    minHeight: 32,
    minWidth: 44,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  textChipOn: { backgroundColor: content.ink },
});
