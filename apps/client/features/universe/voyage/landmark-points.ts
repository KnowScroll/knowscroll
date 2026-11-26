/**
 * Where the landmarks earned on a planet stand on its globe in the new look: the same spots the SVG globe and the landed
 * map put their pennants on (`landmarkSpots`, `planet/planet-stage.tsx`), as points on the band the globe is drawn from.
 * The first earned stands first, so a landmark never moves when another is earned. Pure; reached from the main bundle.
 */
import type { CollectionLandmark } from '@knowscroll/client-core';
import { landmarkSpots, type Chart, type GlobeWorld } from '@knowscroll/scene-core';
import { latitudeOfBandY } from './world-texture';

/** One landmark's pennant: its key, its finish, and where it stands (band column, latitude in radians). */
export interface LandmarkPoint {
  readonly key: string;
  readonly tier: CollectionLandmark['tier'];
  readonly x: number;
  readonly lat: number;
}

/** The pennants of a planet's landmarks on its world (see the top of this file). */
export function landmarkPoints(
  landmarks: readonly CollectionLandmark[],
  spec: { readonly seed: string; readonly variant: number },
  world: GlobeWorld,
  chart: Chart,
): readonly LandmarkPoint[] {
  if (landmarks.length === 0) return [];
  const ordered = [...landmarks].sort((a, b) => a.earnedAt.localeCompare(b.earnedAt) || a.key.localeCompare(b.key));
  const spots = landmarkSpots(spec.seed, spec.variant, world, chart, ordered.length);
  return spots.map((at, place) => ({
    key: `${ordered[place]!.assetId}:${String(ordered[place]!.revision)}`,
    tier: ordered[place]!.tier,
    x: at.x,
    lat: latitudeOfBandY(at.y),
  }));
}
