import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content, spacing } from '@knowscroll/design-tokens';
import { Text, useDisplay } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { SAMPLE_SPACE } from '../universe/space/space-definition';
import { SpaceSimpleLists } from '../universe/space/space-simple-lists';
import type { SpaceChoice, SpaceFailure } from '../universe/space/space-surface';
import { SpaceView } from '../universe/space/space-view';
import { SpaceGalleryRecorder, type SpaceGalleryStats } from './space-gallery-recorder';

/** Marker the web smoke and the Android flow look for; it is never in a production export. */
export const spaceGalleryMarker = 'ks-space-gallery';

const BACKEND = Platform.OS === 'web' ? 'WebGL on a DOM canvas' : 'expo-gl';

function readoutText(stats: SpaceGalleryStats, reducedMotion: boolean): string {
  if (stats.failure !== null)
    return `Simple lists shown (${stats.failure}${stats.failureDetail === null ? '' : `: ${stats.failureDetail}`})`;
  const interval = stats.meanIntervalMs === null ? 'n/a' : `${stats.meanIntervalMs.toFixed(1)} ms`;
  const draw = stats.meanDrawMs === null ? 'n/a' : `${stats.meanDrawMs.toFixed(1)} ms`;
  const lit = stats.lastProbe === null ? 'n/a' : `${stats.lastProbe.litPixels}/${stats.lastProbe.sampledPixels}`;
  return `Drawing with ${BACKEND} · ${stats.frames} frames · every ${interval} · draw ${draw} · lit ${lit}${
    reducedMotion ? ' · reduced motion' : ''
  }`;
}

/**
 * The developer gallery's space renderer page (v3 U-0): the sample sun, two planets and nebula
 * drawn by three.js, with the frame numbers the gate reads. Present only in builds made with
 * `EXPO_PUBLIC_KS_GALLERY=1`. The Universe tab does not use it yet.
 */
export function SpaceGalleryScreen() {
  useDocumentTitle('Space renderer · KnowScroll');
  const insets = useSafeAreaInsets();
  const { reducedMotion } = useDisplay();
  const recorder = useMemo(() => new SpaceGalleryRecorder(), []);
  const [stats, setStats] = useState<SpaceGalleryStats>(() => recorder.stats());
  const [chosen, setChosen] = useState<string>('Nothing chosen');

  useEffect(() => {
    (globalThis as { __ksSpace?: SpaceGalleryRecorder }).__ksSpace = recorder;
    const timer = setInterval(() => {
      const current = recorder.stats();
      setStats(current);
      // The emulator lane greps the device log for these lines (maestro/run-ci.sh).
      // eslint-disable-next-line no-console -- developer gallery only: frame numbers for the gate
      console.info(`KS-SPACE-GATE ${JSON.stringify(current)}`);
    }, 1000);
    return () => {
      clearInterval(timer);
      delete (globalThis as { __ksSpace?: SpaceGalleryRecorder }).__ksSpace;
    };
  }, [recorder]);

  const diagnostics = useMemo(
    () => ({
      onFrame: (sample: Parameters<SpaceGalleryRecorder['record']>[0]) => recorder.record(sample),
      onFailure: (reason: SpaceFailure, detail?: string) => {
        recorder.fail(reason, detail);
        setStats(recorder.stats());
      },
    }),
    [recorder],
  );
  const onChoose = (choice: SpaceChoice): void => setChosen(`${choice.name} (${choice.kind})`);

  return (
    <ScrollView
      testID={spaceGalleryMarker}
      style={styles.page}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing[4] }]}
    >
      <Text variant="heading" heading={1}>
        Space renderer
      </Text>
      <Text variant="label" color={content.ink2} testID="ks-space-readout">
        {readoutText(stats, reducedMotion)}
      </Text>
      <Text variant="label" color={content.ink2} testID="ks-space-chosen">
        {chosen}
      </Text>
      <View style={styles.stage} testID="ks-space-stage">
        <SpaceView
          definition={SAMPLE_SPACE}
          onChoose={onChoose}
          diagnostics={diagnostics}
          fallback={() => <SpaceSimpleLists definition={SAMPLE_SPACE} onChoose={onChoose} />}
        />
      </View>
      <Text variant="body" color={content.ink2}>
        Scroll the scene off screen and its loop stops; bring it back and it continues.
      </Text>
      <View style={styles.spacer} />
      <Text variant="body" color={content.ink2}>
        End of the page.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: content.paper },
  content: { paddingHorizontal: spacing[5], paddingBottom: spacing[8], gap: spacing[3] },
  stage: { height: 560, width: '100%', maxWidth: 420, overflow: 'hidden', borderRadius: 16 },
  spacer: { height: 1400 },
});
