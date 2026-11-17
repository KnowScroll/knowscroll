import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { Text } from '../../text/text';
import { KIT_PICTURES } from '../kit';
import { useStagePictures, type StagePictures, type StageTransition } from './use-stage-pictures';

/** The kits a figure can be drawn with, by the id a document names them by. */
export type KitId = keyof typeof KIT_PICTURES;

/**
 * A picture as a kit draws it: one state, or the picture of the whole journey made of every state (V3 F10).
 * `alt` is the words for it, derived by code; `key` names it, so a new key is a new picture to move to.
 */
export type FigureState =
  | {
      readonly kind: 'state';
      readonly kit: KitId;
      readonly state: unknown;
      readonly alt: string;
      readonly key: string;
    }
  | {
      readonly kind: 'recap';
      readonly kit: KitId;
      readonly states: readonly unknown[];
      readonly alt: string;
      readonly key: string;
    };

/** What a frame needs to draw a figure this frame: the layers, its words, and how it last changed. */
export interface DrawnFigure {
  readonly kit: KitId;
  readonly layers: StagePictures<unknown>['layers'];
  readonly alt: string;
  readonly transition: StageTransition;
  /** The tilt the picture is drawn at, when the reader has turned Earth's axis away from today's. */
  readonly turnedTo: number | undefined;
}

function sceneOf(figure: FigureState): unknown {
  const kit = KIT_PICTURES[figure.kit];
  if (figure.kind === 'state') return kit.sceneOf(figure.state);
  // A recap figure is made only where the kit draws one for these states (`stageFigureAt`).
  return kit.recap?.sceneOf(figure.states);
}

/**
 * A figure over time (D-133): moving to a new figure glides inside one view and fades between views, through
 * `useStagePictures`. A tilt the reader turned is drawn at once, so the picture follows the slider under the finger.
 */
export function useKitFigure(figure: FigureState, reducedMotion: boolean, tilt?: number): DrawnFigure {
  const kit = KIT_PICTURES[figure.kit];
  const target = useMemo(
    () => ({ key: `${figure.kit}/${figure.key}`, kit: figure.kit, scene: sceneOf(figure) }),
    [figure],
  );
  const { layers, transition } = useStagePictures(target, reducedMotion, kit);
  const turning =
    figure.kind === 'state' && tilt !== undefined && kit.atTilt?.isTurned(tilt) === true ? kit.atTilt : undefined;
  if (turning === undefined || figure.kind !== 'state' || tilt === undefined) {
    return { kit: figure.kit, layers, alt: figure.alt, transition, turnedTo: undefined };
  }
  return {
    kit: figure.kit,
    layers: [{ key: target.key, scene: turning.sceneOf(figure.state, tilt), opacity: 1 }],
    alt: turning.describe(figure.state, tilt),
    transition,
    turnedTo: tilt,
  };
}

/**
 * The drawing of a figure inside whatever frame holds it: an image named by its words, or, as the text version, the
 * words alone. The layers are hidden from assistive tech, so a screen reader hears the words once.
 */
export function FigureDrawing({
  drawn,
  textVersion = false,
}: {
  readonly drawn: DrawnFigure;
  readonly textVersion?: boolean;
}) {
  const { Picture } = KIT_PICTURES[drawn.kit];
  if (textVersion) {
    return (
      <View style={styles.text}>
        <Text variant="body">{drawn.alt}</Text>
      </View>
    );
  }
  return (
    <View role="img" aria-label={drawn.alt} accessibilityLabel={drawn.alt} style={StyleSheet.absoluteFill}>
      {drawn.layers.map((layer) => (
        <View
          key={layer.key}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          style={[StyleSheet.absoluteFill, { opacity: layer.opacity }]}
          pointerEvents="none"
        >
          <Picture scene={layer.scene} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { flex: 1, justifyContent: 'center', padding: spacing[4] },
});
