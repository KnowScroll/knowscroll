import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { universe } from '@knowscroll/design-tokens';
import { Text, useDisplay } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { crossingFrame, crossingSeconds } from '../universe/crossing/crossing-frame';
import { CrossingStage } from '../universe/crossing/crossing-stage';
import { useCrossingClock } from '../universe/crossing/use-crossing-clock';
import type { SpaceFailure } from '../universe/space/space-surface';
import { readCrossingParams } from './crossing-gallery-params';

/** The seed of "your" bubble in the gallery; the friend's is made from the name. */
const YOURS = 'you';

/**
 * `?scene=crossing` of the developer space gallery: the crossing to a friend's Universe, full screen. By default one still
 * at film time `q` (`&q=0.30`), with no animation, so frames can be compared with the prototype's. `&dir=home` is the way
 * home, `&name=Ravi&shared=Attention,Stars` the friend and what you share, `&seen=1` the shorter film, and `&play=1`
 * plays the film in real time (not under reduced motion: no film). Never part of a visit; the gallery only.
 */
export function CrossingGalleryPage() {
  useDocumentTitle('Crossing · KnowScroll');
  const { reducedMotion } = useDisplay();
  const raw = useLocalSearchParams<{
    q?: string;
    dir?: string;
    name?: string;
    shared?: string;
    play?: string;
    seen?: string;
  }>();
  const params = readCrossingParams(raw);
  const { direction, name, play } = params;
  // The list is rebuilt on every read of the address; its text is what makes the frame the same.
  const sharedKey = params.shared.join(',');
  const seconds = crossingSeconds(direction, params.seen);
  const playing = play && !reducedMotion;
  const filmTime = useCrossingClock(playing, seconds);
  const q = play ? filmTime : params.q;

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failure, setFailure] = useState<SpaceFailure>();
  const [drawn, setDrawn] = useState<number | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ width, height });
  }, []);

  const frame = useMemo(
    () =>
      size === null
        ? null
        : crossingFrame(q, direction, {
            size,
            friendName: name,
            names: sharedKey === '' ? [] : sharedKey.split(','),
            seconds,
            reducedMotion,
          }),
    [size, q, direction, name, sharedKey, seconds, reducedMotion],
  );
  const friendSeed = `friend:${name}`;

  return (
    <View testID="ks-crossing-page" style={styles.page} onLayout={onLayout}>
      {play && reducedMotion ? (
        <View style={styles.note}>
          <Text variant="label" color={universe.label2} testID="ks-crossing-reduced">
            Reduced motion: the crossing is not played.
          </Text>
        </View>
      ) : frame === null || size === null ? null : (
        <CrossingStage
          frame={frame}
          size={size}
          behindSeed={direction === 'home' ? friendSeed : YOURS}
          aheadSeed={direction === 'home' ? YOURS : friendSeed}
          onDrawn={(done) => setDrawn(done.q)}
          onFailure={setFailure}
          preserveDrawingBuffer
        />
      )}
      {drawn === null ? null : (
        // Says the shader's part of the frame is on the canvas (and which q), for the browser spec and the stills.
        <View
          testID="ks-crossing-ready"
          accessibilityLabel={`drawn q ${drawn.toFixed(3)}`}
          pointerEvents="none"
          style={styles.ready}
        />
      )}
      {failure === undefined ? null : (
        <Text variant="label" color={universe.label2} testID="ks-crossing-failure" style={styles.failure}>
          {`Shader not drawn (${failure})`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000000' },
  note: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  failure: { position: 'absolute', left: 16, bottom: 16 },
  ready: { position: 'absolute', left: 0, top: 0, width: 1, height: 1 },
});
