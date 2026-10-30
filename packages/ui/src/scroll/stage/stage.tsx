import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, borderWidth, spacing } from '@knowscroll/design-tokens';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { Text } from '../../text/text';
import { EarthSkyPicture, sceneOf } from '../kit';
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
  readonly height: number;
}

/**
 * The pinned stage (D-133): one picture that changes as the reader moves from stop to stop. Its
 * accessible name is the description of the state it shows, derived by code in the document, so a
 * screen reader hears exactly what the picture draws. The drawing is the kit's; this component only
 * picks the state for the current stop and moves between states.
 */
export function Stage({ document, stopId, reducedMotion, textVersion = false, height }: StageProps) {
  const entry = stageEntryAt(document.stage, document.stops, stopId);
  const target = useMemo(() => ({ key: entry.stop, scene: sceneOf(entry.state) }), [entry]);
  const { layers, transition } = useStagePictures(target, reducedMotion);
  return (
    <View
      testID="stage"
      style={[styles.frame, { height }]}
      {...dataSet({ ksStageState: entry.stop, ksStageTransition: transition })}
    >
      {textVersion ? (
        <View style={styles.text}>
          <Text variant="body">{entry.alt}</Text>
        </View>
      ) : (
        <View role="img" aria-label={entry.alt} accessibilityLabel={entry.alt} style={StyleSheet.absoluteFill}>
          {layers.map((layer) => (
            <View
              key={layer.key}
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              style={[StyleSheet.absoluteFill, { opacity: layer.opacity }]}
              pointerEvents="none"
            >
              <EarthSkyPicture scene={layer.scene} />
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
