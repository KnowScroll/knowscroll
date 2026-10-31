import { Circle, Ellipse, G, Path } from 'react-native-svg';
import type { Point } from '@knowscroll/scene-core';

/** A landmark as a planet's drawing places it: where its pole stands, and its finish. */
export interface LandmarkMarker {
  readonly key: string;
  readonly tier: 'gold' | 'plain';
  readonly at: Point;
}

const INK = '#15302a';
const GOLD = '#f5c518';
const PAPER = '#fffdf2';

/**
 * A landmark painted on a planet (D-089): a small pennant on a pole in the Universe's flat style,
 * gold for a gold finish and cream for a plain one. Its foot stands at `at`. Decoration: it is hidden
 * from assistive technology, which reads the landmark in the list. It does not move, so reduced
 * motion changes nothing about it.
 */
export function LandmarkMark({ at, tier, scale = 1 }: { at: Point; tier: 'gold' | 'plain'; scale?: number }) {
  return (
    <G testID={`landmark-mark-${tier}`} transform={`translate(${at.x} ${at.y}) scale(${scale})`}>
      <Ellipse cx={0} cy={0} rx={7} ry={2.6} fill={INK} opacity={0.28} />
      <Path d="M0 0V-24" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
      <Path
        d="M0.8 -24L14 -19.4L0.8 -14.6Z"
        fill={tier === 'gold' ? GOLD : PAPER}
        stroke={INK}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <Circle cx={0} cy={-24.6} r={1.9} fill={INK} />
    </G>
  );
}
