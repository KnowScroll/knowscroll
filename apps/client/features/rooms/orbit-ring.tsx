import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Ellipse } from 'react-native-svg';
import { content } from '@knowscroll/design-tokens';

/**
 * The ring that marks an agent (T3 "The ring next to a name means agent. It can't be removed or hidden", v3 R-8b, D-279): a small
 * orbit, a body and the thing that goes round it, drawn in ink. Every AI label wears one and there is no way to draw a label without
 * it, so a resident or a scout is never mistaken for a person. It has its own name for a screen reader ("Agent ring"), read before the
 * label that says what kind of agent it is; it never relies on colour.
 */
export function OrbitRing({ size = 18 }: { readonly size?: number }) {
  return (
    <View
      accessible
      role="img"
      accessibilityLabel="Agent ring"
      testID="orbit-ring"
      style={[styles.ring, { width: size, height: size }]}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Ellipse
          cx="12"
          cy="12"
          rx="10"
          ry="4.6"
          transform="rotate(-28 12 12)"
          fill="none"
          stroke={content.ink}
          strokeWidth={2}
        />
        <Circle cx="12" cy="12" r="3.4" fill={content.ink} />
        <Circle cx="20.83" cy="7.31" r="2" fill={content.ink} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({ ring: { alignItems: 'center', justifyContent: 'center' } });
