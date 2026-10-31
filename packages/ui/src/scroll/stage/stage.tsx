import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, borderWidth, spacing } from '@knowscroll/design-tokens';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { Text } from '../../text/text';
import { KIT_PICTURES } from '../kit';
import { dataSet } from '../stage-reader/data-set';
import { stageEntryAt } from './stage-state';
import { useStagePictures } from './use-stage-pictures';

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
  readonly height: number;
}

/**
 * The pinned stage (D-133): one picture that changes as the reader moves from stop to stop. Its
 * accessible name is the description of the state it shows, derived by code in the document, so a
 * screen reader hears exactly what the picture draws. The drawing is the kit's (the stage names which,
 * D-194); this component only picks the state for the current stop and moves between states.
 */
export function Stage({ document, stopId, reducedMotion, textVersion = false, tilt, height }: StageProps) {
  const kitId = document.stage.kit;
  const kit = KIT_PICTURES[kitId];
  const entry = stageEntryAt(document.stage, document.stops, stopId);
  const target = useMemo(
    () => ({ key: `${kitId}/${entry.stop}`, kit: kitId, scene: kit.sceneOf(entry.state) }),
    [entry, kit, kitId],
  );
  const { layers: moving, transition } = useStagePictures(target, reducedMotion, kit);
  // A turned axis is drawn at once, so the picture follows the slider under the finger; it needs no move between states.
  const turning = tilt !== undefined && kit.atTilt?.isTurned(tilt) === true ? { tilt, kit: kit.atTilt } : undefined;
  const layers =
    turning === undefined
      ? moving
      : [{ key: entry.stop, scene: turning.kit.sceneOf(entry.state, turning.tilt), opacity: 1 }];
  const alt = turning === undefined ? entry.alt : turning.kit.describe(entry.state, turning.tilt);
  return (
    <View
      testID="stage"
      style={[styles.frame, { height }]}
      {...dataSet({
        ksStageState: entry.stop,
        ksStageTransition: transition,
        ...(turning === undefined ? {} : { ksStageTilt: String(turning.tilt) }),
      })}
    >
      {textVersion ? (
        <View style={styles.text}>
          <Text variant="body">{alt}</Text>
        </View>
      ) : (
        <View role="img" aria-label={alt} accessibilityLabel={alt} style={StyleSheet.absoluteFill}>
          {layers.map((layer) => (
            <View
              key={layer.key}
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              style={[StyleSheet.absoluteFill, { opacity: layer.opacity }]}
              pointerEvents="none"
            >
              <kit.Picture scene={layer.scene} />
            </View>
          ))}
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
  text: { flex: 1, justifyContent: 'center', padding: spacing[4] },
});
