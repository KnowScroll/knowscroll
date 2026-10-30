import { View } from 'react-native';
import Svg, { Circle, Path, Polygon } from 'react-native-svg';
import { universe } from '@knowscroll/design-tokens';

/**
 * The five reactions of Talk, in the order the bar and the pills show them. The set is the wire's
 * (`MESSAGE_REACTION_KINDS` in the contracts); this package has no dependency on them, so the two
 * lists are kept equal by a test in the client.
 */
export const REACTION_KINDS = ['spark', 'mind_blown', 'ha', 'heart', 'question'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** The words a person and a screen reader use for each reaction (T3 kit: Spark, Mind blown, Ha, Heart, Question). */
export const REACTION_LABELS: Readonly<Record<ReactionKind, string>> = {
  spark: 'Spark',
  mind_blown: 'Mind blown',
  ha: 'Ha',
  heart: 'Heart',
  question: 'Question',
};

/** A burst of `points` spikes between two radii, as a polygon of the 24 × 24 view box. */
function burst(points: number, outer: number, inner: number): string {
  return Array.from({ length: points * 2 }, (_, index) => {
    const angle = (Math.PI * index) / points - Math.PI / 2;
    const radius = index % 2 === 0 ? outer : inner;
    return `${(12 + radius * Math.cos(angle)).toFixed(2)},${(12 + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
}

const BURST = burst(8, 11, 6.2);

/**
 * One of the five reactions, drawn: the app owns these glyphs and there is no emoji keyboard
 * (T3 kit). Always hidden from assistive technology: the control that holds it carries the name.
 */
export function ReactionGlyph({ kind, size = 20 }: { readonly kind: ReactionKind; readonly size?: number }) {
  return (
    <View
      accessible={false}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {kind === 'spark' ? (
          <Path
            d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z"
            fill={universe.focus}
            stroke={universe.ink}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        ) : null}
        {kind === 'mind_blown' ? (
          <>
            <Polygon
              points={BURST}
              fill={universe.orange}
              stroke={universe.ink}
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
            <Circle cx={12} cy={12} r={3} fill={universe.focus} />
          </>
        ) : null}
        {kind === 'ha' ? (
          <>
            <Circle cx={12} cy={12} r={10} fill={universe.focus} stroke={universe.ink} strokeWidth={1.6} />
            <Path
              d="M7.4 9.4l2.2 1.2M16.6 9.4l-2.2 1.2"
              stroke={universe.ink}
              strokeWidth={1.8}
              strokeLinecap="round"
            />
            <Path d="M7 13.2h10a5 5 0 0 1-10 0z" fill={universe.ink} />
          </>
        ) : null}
        {kind === 'heart' ? (
          <Path
            d="M12 21s-8-4.9-8-11a4.4 4.4 0 0 1 8-2.5A4.4 4.4 0 0 1 20 10c0 6.1-8 11-8 11z"
            fill={universe.red}
            stroke={universe.ink}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        ) : null}
        {kind === 'question' ? (
          <>
            <Circle cx={12} cy={12} r={10} fill={universe.cobalt} stroke={universe.ink} strokeWidth={1.6} />
            <Path
              d="M9.4 9.6a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1-1.3 1.9"
              fill="none"
              stroke={universe.paper}
              strokeWidth={2.2}
              strokeLinecap="round"
            />
            <Circle cx={12} cy={17} r={1.3} fill={universe.paper} />
          </>
        ) : null}
      </Svg>
    </View>
  );
}
