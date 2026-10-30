import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewInstance } from 'react-native';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { callsOf, type ScrollDocumentV2 } from '../model';
import { toggleSemantics } from '../../display/semantics';
import { useDisplay } from '../../display/display';
import { useFocusRing } from '../../display/focus-ring';
import { Text } from '../../text/text';
import { Stage } from '../stage';
import { CallView } from './call-view';
import { dataSet } from './data-set';
import { EndTray, type NextPartPeek } from './end-tray';
import type { PartMove } from './part-gesture';
import { PartSwipe } from './part-swipe';
import { ReaderFocus } from './reader-focus';
import type { ReaderKey } from './reader-keys';
import { Spine, type SpineDot } from './spine';
import { AsideView, ReadStopView } from './stop-view';
import { useCallPlay } from './use-call-play';
import { useReaderScroll } from './use-reader-scroll';
import { useStopReading, type StageReadingObserver } from './use-stop-reading';

/** What the app can do for the reader beyond reading: each is also a button, so no key or gesture stands alone. */
export interface ReaderCommands {
  readonly universe?: () => void;
  readonly ask?: () => void;
  readonly format?: () => void;
  readonly nextPart?: () => void;
  readonly previousPart?: () => void;
  readonly nextTopic?: () => void;
}

export interface StageReaderHandle {
  /** The stop the reader is on, or `undefined` at the end tray. */
  readonly capture: () => { readonly stopId: string } | undefined;
  readonly jumpToStop: (stopId: string) => void;
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
  readonly onDone?: (() => void) | undefined;
  /** "Part 1 of 3": drawn on the stage where the top bar has no room for it (a phone). */
  readonly partLabel?: string | undefined;
}

const MIN_STAGE = 176;

/** The stage is a third of the screen, never less than a readable picture nor more than a column's worth. */
function stageHeightFor(windowHeight: number, wide: boolean): number {
  return Math.round(Math.min(wide ? 340 : 300, Math.max(MIN_STAGE, windowHeight * 0.34)));
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
  onDone,
  partLabel,
}: StageReaderProps) {
  const { reducedMotion, breakpoint } = useDisplay();
  const { height: windowHeight } = useWindowDimensions();
  const dots = useMemo(() => spineOf(document), [document]);
  const calls = useMemo(() => callsOf(document), [document]);
  const startAt = Math.max(0, indexOfStop(document.stops, initialStopId));
  const scroller = useRef<ScrollViewInstance>(null);
  const text = useReaderScroll({
    scroller,
    sections: document.stops.length + 1,
    startAt,
    reducedMotion,
    onPullPastEnd: commands.nextTopic,
  });
  const { current, jump } = text;
  const activeStopId = current < document.stops.length ? document.stops[current]?.id : undefined;
  const reading = useStopReading(observer, activeStopId, paused);
  const play = useCallPlay(reading);
  const [textVersion, setTextVersion] = useState(false);
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
    }),
    [activeStopId, document.stops, jump],
  );

  const toggleAside = (asideId: string) =>
    setOpened((all) => {
      const next = new Set(all);
      if (!next.delete(asideId)) next.add(asideId);
      return next;
    });
  const showSmallPrint = (asideId: string) => {
    setOpened((all) => new Set(all).add(asideId));
    jump(indexOfStop(document.stops, document.asides.find((aside) => aside.id === asideId)?.anchorStop), false);
  };
  const move = (part: PartMove) =>
    run(
      part === 'next-part' ? commands.nextPart : part === 'previous-part' ? commands.previousPart : commands.nextTopic,
    );

  const onKey = (key: ReaderKey): boolean => {
    const stop = document.stops[current];
    const open = stop !== undefined && stop.kind !== 'read' ? stop : undefined;
    switch (key.action) {
      case 'next-stop':
        jump(text.heading() + 1, true);
        return true;
      case 'previous-stop':
        jump(text.heading() - 1, true);
        return true;
      case 'next-part':
        return run(commands.nextPart);
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
      case 'text-version':
        if (document.stage === undefined) return false;
        setTextVersion((now) => !now);
        return true;
      case 'pick':
        if (open === undefined) return false;
        play.pick(open.id, key.option - 1, open.options.length);
        return true;
      case 'lock-in':
        return open !== undefined && play.lock(open.id);
    }
  };

  const wide = breakpoint === 'tablet' || breakpoint === 'desktop';
  const sectionHeight = text.viewport > 0 ? Math.round(text.viewport * 0.8) : 320;
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
            height={stageHeightFor(windowHeight, wide)}
          />
          {partLabel === undefined || wide ? null : (
            <View style={styles.partChip}>
              <Text variant="monoXs">{partLabel}</Text>
            </View>
          )}
          <TextVersionSwitch on={textVersion} onPress={() => setTextVersion((now) => !now)} />
        </View>
      )}
      <View style={styles.body}>
        <PartSwipe onMove={move} atEnd={text.atEnd}>
          <ScrollView
            ref={scroller}
            testID="stop-scroller"
            style={styles.scroller}
            contentContainerStyle={styles.content}
            {...text.scrollProps}
          >
            {document.stops.map((stop, index) => (
              <View
                key={stop.id}
                role="group"
                aria-label={dots[index]?.label}
                onLayout={text.measureSection(index)}
                style={[styles.section, { minHeight: sectionHeight }]}
                {...dataSet({ ksStop: stop.id })}
              >
                {stop.kind === 'read' ? (
                  <ReadStopView stop={stop} />
                ) : (
                  <CallView
                    call={stop}
                    position={`${String(calls.indexOf(stop) + 1)} of ${String(calls.length)}`}
                    state={play.stateOf(stop.id)}
                    onPick={(option) => play.pick(stop.id, option, stop.options.length)}
                    onLockIn={() => play.lock(stop.id)}
                  />
                )}
                {document.asides
                  .filter((aside) => aside.anchorStop === stop.id)
                  .map((aside) => (
                    <AsideView
                      key={aside.id}
                      aside={aside}
                      expanded={opened.has(aside.id)}
                      onToggle={() => toggleAside(aside.id)}
                    />
                  ))}
              </View>
            ))}
            <View
              role="group"
              aria-label={dots[dots.length - 1]?.label}
              onLayout={text.measureSection(document.stops.length)}
              style={[styles.section, { minHeight: sectionHeight }]}
              {...dataSet({ ksStop: 'end' })}
            >
              <EndTray
                recap={document.recap}
                nextPart={nextPart}
                onSmallPrint={
                  document.recap.smallPrintAside === undefined
                    ? undefined
                    : () => showSmallPrint(document.recap.smallPrintAside ?? '')
                }
                onDone={onDone}
                onNextTopic={commands.nextTopic}
              />
            </View>
          </ScrollView>
        </PartSwipe>
        <Spine dots={dots} current={current} onJump={(index) => jump(index, false)} />
      </View>
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

/** Runs a command the app may not provide; whether it ran is whether the key or swipe was used. */
function run(command: (() => void) | undefined): boolean {
  if (command === undefined) return false;
  command();
  return true;
}

const styles = StyleSheet.create({
  body: { flex: 1, minHeight: 0, flexDirection: 'row' },
  scroller: { flex: 1 },
  content: { paddingBottom: spacing[12] },
  section: { paddingHorizontal: layout.gutter, paddingTop: spacing[5], paddingBottom: spacing[5], gap: spacing[4] },
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
  partChip: {
    position: 'absolute',
    left: spacing[2],
    top: spacing[2],
    paddingHorizontal: spacing[2],
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
});
