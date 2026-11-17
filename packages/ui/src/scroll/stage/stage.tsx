import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, borderWidth, spacing } from '@knowscroll/design-tokens';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { Text } from '../../text/text';
import { dataSet } from '../../display/data-set';
import { printedSurface } from '../../display/printed';
import { FigureDrawing, useKitFigure } from './kit-figure';
import { stageFigureAt } from './stage-figure';
import { tiltText } from './tilt-control';

export interface StageProps {
  readonly document: Pick<ScrollDocumentV2, 'stops'> & { readonly stage: NonNullable<ScrollDocumentV2['stage']> };
  /** The stop the reader is on: the stage shows the state that holds there. */
  readonly stopId: string;
  readonly reducedMotion: boolean;
  /** "Text version": the state as its sentences instead of its picture. */
  readonly textVersion?: boolean;
  /**
   * The tilt of Earth's axis the reader has turned the picture to at a Final call that hands it over
   * (D-187; only the Earth & sky kit has an axis to turn). Absent, or today's tilt: the picture of the
   * state, moved between states as usual.
   */
  readonly tilt?: number | undefined;
  /**
   * The reader is at the end: a kit that can draw the picture of the whole journey shows it instead of the last state
   * (V3 F10, "the picture you built"). A kit that cannot keeps its last state.
   */
  readonly recap?: boolean | undefined;
  readonly height: number;
}

/**
 * The pinned stage (D-133): one picture that changes as the reader moves from stop to stop. Its
 * accessible name is the description of the state it shows, derived by code in the document, so a
 * screen reader hears exactly what the picture draws. The drawing is the kit's (the stage names which,
 * D-194); this component only picks the figure for the current stop (`stageFigureAt`) and frames it.
 */
export function Stage({
  document,
  stopId,
  reducedMotion,
  textVersion = false,
  tilt,
  recap = false,
  height,
}: StageProps) {
  const figure = useMemo(
    () => stageFigureAt(document.stage, document.stops, stopId, recap),
    [document.stage, document.stops, stopId, recap],
  );
  const drawn = useKitFigure(figure, reducedMotion, tilt);
  return (
    <View
      testID="stage"
      style={[styles.frame, { height }]}
      // The picture is authored art: Light values wherever it is drawn, in the reader or a sheet (#666).
      {...printedSurface(
        dataSet({
          ksStageState: figure.kind === 'recap' ? 'recap' : figure.key,
          ksStageTransition: drawn.transition,
          ...(drawn.turnedTo === undefined ? {} : { ksStageTilt: String(drawn.turnedTo) }),
        }),
      )}
    >
      <FigureDrawing drawn={drawn} textVersion={textVersion} />
      {tilt === undefined || textVersion ? null : (
        // The tag repeats what the control above the options says, so it is drawn for the eye alone (V3 F9, C3).
        <View
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          style={styles.tiltTag}
          testID="stage-tilt-tag"
        >
          <Text variant="monoXs" color={content.paper}>
            {`TILT ${tiltText(tilt)}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    backgroundColor: content.paper,
    borderBottomWidth: borderWidth.regular,
    borderBottomColor: content.ink,
    overflow: 'hidden',
  },
  tiltTag: {
    position: 'absolute',
    left: spacing[2],
    bottom: spacing[2],
    minHeight: 32,
    paddingHorizontal: spacing[3],
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: content.ink,
  },
});
