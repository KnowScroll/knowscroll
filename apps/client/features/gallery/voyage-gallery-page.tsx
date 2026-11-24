import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space, spacing } from '@knowscroll/design-tokens';
import { Text, useDisplay } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { FrameRateReadout } from '../universe/frame-rate/frame-rate-readout';
import type { SpaceFailure } from '../universe/space/space-surface';
import { indexUniverse, viewFor, type Size } from '../universe/universe-layout';
import { VoyageStage } from '../universe/voyage/voyage-stage';
import { createVisitMapSession, type VisitMapSession } from '../visit/visit-map-session';
import { sampleScene } from './sample-universe';

const noop = (): void => {};

/**
 * `?scene=voyage` of the developer space gallery: the Universe's Round 7.3 look (`VoyageStage`) drawn over the labelled
 * sample universe, so the emulator lane, which cannot sign in, can fly it and drag the ship. The map session is a
 * friend's-universe one (pure and local, over descriptors); it cannot land on a planet, which the flow does not need.
 * The stage fills the screen, as it does on the tab, with the heading and caption laid over it.
 */
export function VoyageGalleryPage() {
  useDocumentTitle('Voyage · KnowScroll');
  const insets = useSafeAreaInsets();
  const { reducedMotion } = useDisplay();
  const scene = useMemo(() => sampleScene(), []);
  const [session] = useState(() => {
    const made = createVisitMapSession({ refresh: () => Promise.resolve() });
    made.setForeground(true);
    made.setDescriptors(scene.descriptors, scene.looks);
    return made;
  });
  const [failure, setFailure] = useState<SpaceFailure>();
  // The page is the only holder of the session, so leaving it drops the session with it; only its foreground is kept honest.
  useEffect(() => {
    session.setForeground(true);
    return () => session.setForeground(false);
  }, [session]);
  useEffect(() => session.configure({ detail: 'full', reducedMotion }), [session, reducedMotion]);
  return (
    <View style={styles.page}>
      {/* The readout is always on here: the emulator's screenshots carry the frame rate. */}
      <FrameRateReadout on>
        <VoyageGalleryStage session={session} scene={scene} onUnavailable={setFailure} />
      </FrameRateReadout>
      <View pointerEvents="none" style={[styles.words, { top: insets.top + spacing[3] }]}>
        <Text variant="heading" heading={1} color={space.label}>
          Voyage
        </Text>
        <Text variant="label" color={space.label2}>
          Labelled sample places, not yours. Tap a system to fly there; drag the ship to a place.
        </Text>
        {failure === undefined ? null : (
          <Text variant="label" color={space.label2} testID="ks-voyage-failure">
            {`Simple lists shown (${failure})`}
          </Text>
        )}
      </View>
    </View>
  );
}

function VoyageGalleryStage({
  session,
  scene,
  onUnavailable,
}: {
  readonly session: VisitMapSession;
  readonly scene: ReturnType<typeof sampleScene>;
  readonly onUnavailable: (reason: SpaceFailure) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const index = useMemo(() => indexUniverse(scene.descriptors, []), [scene]);
  const view = viewFor(index, state.focusId, state.landed);
  const [size, setSize] = useState<Size>({ width: 390, height: 640 });
  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ width, height });
  };
  return (
    <View testID="voyage-gallery-stage" style={styles.stage} onLayout={onLayout}>
      <VoyageStage
        session={session}
        state={state}
        index={index}
        size={size}
        view={view}
        stations={scene.stations}
        onDust={noop}
        onStation={noop}
        onUnavailable={onUnavailable}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: space.s0 },
  stage: { flex: 1, overflow: 'hidden' },
  words: { position: 'absolute', left: spacing[5], right: spacing[5], gap: spacing[1] },
});
