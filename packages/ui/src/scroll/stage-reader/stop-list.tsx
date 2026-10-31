import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { layout, spacing } from '@knowscroll/design-tokens';
import type { CallItStop, FinalCallStop, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { CallState } from './call-state';
import { CallView, type FinalCallPlay } from './call-view';
import { dataSet } from './data-set';
import { EndTray, type NextPartPeek, type SmallPrint } from './end-tray';
import type { Payoff } from './payoff';
import type { StageLock } from './stage-play';
import type { SpineDot } from './spine';
import { AsideView, ReadStopView } from './stop-view';

/** What the list needs from the reader around it. */
export interface StopListProps {
  readonly document: ScrollDocumentV2;
  /** The dot of each section (a stop, then the end): the accessible name of its group. */
  readonly dots: readonly SpineDot[];
  readonly calls: readonly (CallItStop | FinalCallStop)[];
  readonly sectionHeight: number;
  readonly measureSection: (index: number) => (event: LayoutChangeEvent) => void;
  readonly stateOf: (callId: string) => CallState;
  /** What play holds of a Call it: the lock, its spark and combo, and whether it is kept. */
  readonly lockOf: (callId: string) => StageLock | undefined;
  /** Recording is paused: whatever is locked stays on this device. */
  readonly paused: boolean;
  /** A call's reveal was laid out: its section's index and its height with the section's bottom padding. */
  readonly onRevealLayout: (index: number, height: number) => void;
  readonly pick: (callId: string, option: number, optionCount: number) => void;
  readonly lock: (callId: string) => boolean;
  readonly opened: ReadonlySet<string>;
  readonly onToggleAside: (asideId: string) => void;
  /** What the Final call says and hands the reader before it is locked (D-187). */
  readonly final: FinalCallPlay;
  /** How the person's play went, for the payoff at the end (D-189). */
  readonly payoff: Payoff;
  readonly smallPrint: SmallPrint | undefined;
  readonly nextPart: NextPartPeek | undefined;
  readonly related: NextPartPeek | undefined;
  readonly onDone: (() => void) | undefined;
  readonly onNextTopic: (() => void) | undefined;
  readonly onUniverse: (() => void) | undefined;
  readonly onPlayFinal: (() => void) | undefined;
}

/** The sections of the text: one per stop (with the asides beside it) and the end tray, stacked. */
export function StopList(props: StopListProps) {
  const { document, dots, calls, sectionHeight, measureSection } = props;
  return (
    <>
      {document.stops.map((stop, index) => (
        <View
          key={stop.id}
          role="group"
          aria-label={dots[index]?.label}
          onLayout={measureSection(index)}
          style={[styles.section, { minHeight: sectionHeight }]}
          {...dataSet({ ksStop: stop.id })}
        >
          {stop.kind === 'read' ? (
            <ReadStopView stop={stop} />
          ) : (
            <CallView
              call={stop}
              position={`${String(calls.indexOf(stop) + 1)} of ${String(calls.length)}`}
              state={props.stateOf(stop.id)}
              lock={props.lockOf(stop.id)}
              paused={props.paused}
              final={stop.kind === 'final_call' ? props.final : undefined}
              onRevealLayout={(height) => props.onRevealLayout(index, height + SECTION_PADDING)}
              onPick={(option) => props.pick(stop.id, option, stop.options.length)}
              onLockIn={() => props.lock(stop.id)}
            />
          )}
          {document.asides
            .filter((aside) => aside.anchorStop === stop.id)
            .map((aside) => (
              <AsideView
                key={aside.id}
                aside={aside}
                expanded={props.opened.has(aside.id)}
                onToggle={() => props.onToggleAside(aside.id)}
              />
            ))}
        </View>
      ))}
      <View
        role="group"
        aria-label={dots[dots.length - 1]?.label}
        onLayout={measureSection(document.stops.length)}
        style={[styles.section, { minHeight: sectionHeight }]}
        {...dataSet({ ksStop: 'end' })}
      >
        <EndTray
          recap={document.recap}
          hasStage={document.stage !== undefined}
          payoff={props.payoff}
          nextPart={props.nextPart}
          related={props.related}
          smallPrint={props.smallPrint}
          onDone={props.onDone}
          onNextTopic={props.onNextTopic}
          onUniverse={props.onUniverse}
          onPlayFinal={props.onPlayFinal}
        />
      </View>
    </>
  );
}

/** A section's padding above and below its content. */
const SECTION_PADDING = spacing[5];

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: layout.gutter,
    paddingTop: SECTION_PADDING,
    paddingBottom: SECTION_PADDING,
    gap: spacing[4],
  },
});
