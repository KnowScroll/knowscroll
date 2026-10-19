import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, G, Pattern, Rect } from 'react-native-svg';
import { content, space } from '@knowscroll/design-tokens';

/** Background stars of U01, as drawn on the 390 × 844 frame: x, y, radius, opacity. */
const stars: readonly (readonly [number, number, number, number])[] = [
  [24, 120, 1, 0.55],
  [88, 70, 0.8, 0.4],
  [140, 160, 1.2, 0.6],
  [230, 96, 0.9, 0.45],
  [300, 140, 1, 0.5],
  [362, 84, 1.3, 0.6],
  [60, 230, 0.8, 0.35],
  [350, 250, 0.9, 0.4],
  [18, 420, 1.1, 0.5],
  [372, 430, 0.8, 0.35],
  [90, 520, 1, 0.45],
  [250, 610, 0.8, 0.35],
  [40, 660, 1.2, 0.55],
  [330, 690, 1, 0.45],
  [180, 720, 0.8, 0.3],
  [120, 300, 0.7, 0.3],
  [270, 230, 1.4, 0.7],
  [200, 560, 0.9, 0.4],
];

/**
 * The quiet universe ground (U01 "Background only; no promises"): a soft glow of raised and
 * pressed space tones and still background stars, tiled at the frame's own scale so large
 * screens get more sky rather than bigger stars. Decoration only; it promises nothing.
 */
export function UniverseBackdrop({ glow = true }: { glow?: boolean }) {
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="ks-universe-stars" patternUnits="userSpaceOnUse" width={390} height={844}>
            <G fill={content.paper}>
              {stars.map(([cx, cy, r, opacity]) => (
                <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} opacity={opacity} />
              ))}
            </G>
          </Pattern>
        </Defs>
        {glow ? (
          <>
            <Circle cx="50%" cy="43%" r={210} fill={space.s1} opacity={0.55} />
            <Circle cx="50%" cy="43%" r={120} fill={space.s2} opacity={0.35} />
          </>
        ) : null}
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#ks-universe-stars)" />
      </Svg>
    </View>
  );
}
