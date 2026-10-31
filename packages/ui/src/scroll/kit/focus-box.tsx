import type { ReactElement } from 'react';
import { Polygon, Rect } from 'react-native-svg';
import type { Point } from './earth-sky-scene';
import { FOCUS } from './parts';

/**
 * The focus mark for a part that is a region and not a point (D-194, D-204): the same dashed stroke as
 * the shared focus ring, so the focus test finds it. Kits use the ring for a point and these for a bar,
 * a strip or a band.
 */
export function FocusBox({
  x,
  y,
  width,
  height,
}: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): ReactElement {
  return (
    <Rect x={x} y={y} width={width} height={height} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />
  );
}

/** A dashed outline round a slanted band: the points of its outline in order. */
export function FocusOutline({ points }: { readonly points: readonly Point[] }): ReactElement {
  return (
    <Polygon
      points={points.map((point) => `${point.x},${point.y}`).join(' ')}
      fill="none"
      stroke={FOCUS}
      strokeWidth={3}
      strokeDasharray="5 4"
      strokeLinejoin="round"
    />
  );
}
