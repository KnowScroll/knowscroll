import { makeScale, type Scale } from '../blocks/chart/scales';
import type { ScaleBlock, SeriesPoint } from '../model';

/**
 * The views of a scale (D-207). The writer chooses no range: each point from the second on is a wider
 * view that holds every point up to it, so "zoom out" is derived from the data and can never show a
 * range the document does not support.
 */
export interface ZoomStop {
  /** The point this view reaches out to: its label names the chip. */
  readonly label: string;
  /** How many points, from the smallest, this view holds. */
  readonly shown: number;
}

export function zoomStops(scale: Pick<ScaleBlock, 'points'>): readonly ZoomStop[] {
  return scale.points.slice(1).map((point, index) => ({ label: point.label, shown: index + 2 }));
}

/** The view a scale opens on: the nearest one that still holds "you are here". */
export function openingZoom(scale: Pick<ScaleBlock, 'points' | 'here'>): number {
  const needed = (scale.here ?? 0) + 1;
  return Math.max(
    0,
    zoomStops(scale).findIndex((stop) => stop.shown >= needed),
  );
}

export interface ScaleView {
  readonly points: readonly SeriesPoint[];
  readonly axis: Scale;
}

/** The points a view holds and the axis that fits them: from zero for a linear scale, between powers of ten for a log one. */
export function scaleView(scale: Pick<ScaleBlock, 'points' | 'axis'>, shown: number): ScaleView {
  const points = scale.points.slice(0, shown);
  const values = points.map((point) => point.value);
  return {
    points,
    axis: makeScale(values, { scale: scale.axis }, { includeZero: scale.axis === 'linear' }),
  };
}
