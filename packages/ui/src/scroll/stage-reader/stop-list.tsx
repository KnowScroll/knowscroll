import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { layout, spacing } from '@knowscroll/design-tokens';
import type { CallItStop, FinalCallStop, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { CallState } from './call-state';
import { CallView } from './call-view';
import { dataSet } from './data-set';
import { EndTray, type NextPartPeek } from './end-tray';
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
  readonly pick: (callId: string, option: number, optionCount: number) => void;
  readonly lock: (callId: string) => boolean;
  readonly opened: ReadonlySet<string>;
  readonly onToggleAside: (asideId: string) => void;
  readonly onSmallPrint: (asideId: string) => void;
  readonly nextPart: NextPartPeek | undefined;
  readonly onDone: (() => void) | undefined;
  readonly onNextTopic: (() => void) | undefined;
}

/** The sections of the text: one per stop (with the asides beside it) and the end tray, stacked. */
export function StopList(props: StopListProps) {
  const { document, dots, calls, sectionHeight, measureSection } = props;
  const smallPrint = document.recap.smallPrintAside;
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
          nextPart={props.nextPart}
          onSmallPrint={smallPrint === undefined ? undefined : () => props.onSmallPrint(smallPrint)}
          onDone={props.onDone}
          onNextTopic={props.onNextTopic}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: layout.gutter, paddingTop: spacing[5], paddingBottom: spacing[5], gap: spacing[4] },
});
