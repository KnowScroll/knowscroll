import { StyleSheet, View } from 'react-native';
import { UniverseBackdrop } from '../universe-backdrop';
import type { SpaceDefinition } from './space-definition';
import { SpaceView } from './space-view';

/** Stars only (U01 "Empty"): three layers that drift against each other as the camera breathes. */
const EMPTY_SKY: SpaceDefinition = {
  camera: { position: [0, 4, 30], target: [0, 0, 0], drift: 1.6, fogRange: [60, 140] },
  systems: [],
};

/**
 * The quiet sky behind the Empty, loading and Offline states, drawn by the same renderer as the map so
 * the screens read as one place. It promises nothing. When 3D is not available the still stars of the
 * old backdrop are shown instead.
 */
export function SkyBackdrop() {
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
    >
      <SpaceView definition={EMPTY_SKY} fallback={() => <UniverseBackdrop />} />
    </View>
  );
}
