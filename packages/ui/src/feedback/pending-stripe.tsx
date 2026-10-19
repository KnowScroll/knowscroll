import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Pattern, Rect } from 'react-native-svg';
import { status } from '@knowscroll/design-tokens';

/**
 * The "preparing" surface: 135° stripes of paper and paper-2 (`content.pending`). It fills its
 * parent and sits behind the parent's content; it is decoration and never the only cue (the
 * parent also says "Preparing").
 */
export function PendingStripe({ compact = false }: { compact?: boolean }) {
  const id = `ks-pending-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const stripe = compact ? status.preparing.compactStripe : status.preparing.stripe;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessible={false}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern
            id={id}
            patternUnits="userSpaceOnUse"
            width={stripe * 2}
            height={stripe * 2}
            patternTransform="rotate(45)"
          >
            <Rect x={0} y={0} width={stripe} height={stripe * 2} fill={status.preparing.a} />
            <Rect x={stripe} y={0} width={stripe} height={stripe * 2} fill={status.preparing.b} />
          </Pattern>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
