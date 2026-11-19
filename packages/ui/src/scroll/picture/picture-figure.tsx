import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { canonicalJson, describePicture, type Picture, type PictureState } from '@knowscroll/scroll-model';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import { useStagePictures, type SceneBlend } from '../stage/use-stage-pictures';
import { canGlidePictures, lerpPictureScene } from './blend';
import { layoutPicture } from './layout';
import { pictureColours } from './palette';
import { PictureSvg } from './picture-svg';
import type { PictureScene } from './scene';

const BLEND: SceneBlend<PictureScene> = { canTween: canGlidePictures, lerpScene: lerpPictureScene };

export interface PictureDrawingProps {
  readonly picture: Picture;
  readonly state: PictureState;
  readonly reducedMotion: boolean;
  /** The words instead of the drawing (the Text chip, or the reader's text version). */
  readonly textVersion?: boolean;
  /** The reader's text scale; a picture's labels grow with it, within the box. */
  readonly textScale?: number;
  /** A part a linked phrase was just tapped for. */
  readonly pulsing?: string | undefined;
}

/**
 * One picture of a document v3, drawn to fill whatever box holds it (a held plate, a figure after a beat, a cover). It
 * measures the box, lays the picture out for it, and moves between states: the same picture glides, anything else
 * cross-fades, and under reduced motion every change cross-fades (`useStagePictures`). Its words, derived by code from
 * the same data (`describePicture`), name the image for assistive tech and replace it as the text version, so the two
 * can never disagree.
 */
export function PictureDrawing({
  picture,
  state,
  reducedMotion,
  textVersion = false,
  textScale = 1,
  pulsing,
}: PictureDrawingProps) {
  const page = usePagePalette();
  const colours = useMemo(() => pictureColours(page), [page]);
  const [box, setBox] = useState<{ readonly width: number; readonly height: number }>({ width: 0, height: 0 });
  const alt = useMemo(() => describePicture(picture, state), [picture, state]);
  const target = useMemo(() => {
    const scene = layoutPicture(picture, state, { ...box, textScale });
    return {
      key: `${picture.id}/${canonicalJson(state)}/${box.width}x${box.height}/${textScale}`,
      kit: 'picture',
      scene,
    };
  }, [picture, state, box, textScale]);
  const { layers } = useStagePictures(target, reducedMotion, BLEND);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (Math.round(width) !== box.width || Math.round(height) !== box.height)
      setBox({ width: Math.round(width), height: Math.round(height) });
  };
  if (textVersion)
    return (
      <View style={styles.text}>
        <Text variant="body">{alt}</Text>
      </View>
    );
  return (
    <View role="img" aria-label={alt} accessibilityLabel={alt} style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {box.width === 0
        ? null
        : layers.map((layer) => (
            <View
              key={layer.key}
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { opacity: layer.opacity }]}
            >
              <PictureSvg scene={layer.scene} colours={colours} pulsing={pulsing} />
            </View>
          ))}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { padding: spacing[3] },
});
