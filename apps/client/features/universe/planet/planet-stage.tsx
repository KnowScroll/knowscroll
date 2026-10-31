import { useCallback, useEffect, useMemo } from 'react';
import type { CollectionLandmark } from '@knowscroll/client-core';
import { chartWorld, landmarkSpots, type Chart, type SceneDescriptor } from '@knowscroll/scene-core';
import type { LandmarkMarker } from '../collection/landmark-mark';
import type { SceneProps } from '../scene-parts';
import { looksById } from '../space/space-model';
import { PlanetGlobe } from './planet-globe';
import { PlanetMap } from './planet-map';
import { paletteOf } from './planet-palette';
import { planPlanet } from './planet-plan';
import { useGlobeWorld, useMapWorld } from './use-planet-world';

/** The words a region's target is announced with: "Deployment, a region", and where the person was. */
export const regionName = (region: SceneDescriptor, hereId: string | null | undefined): string =>
  region.objectId === hereId ? `${region.label} · you were here` : region.label;

/**
 * A planet's globe (U03) or, once landed, its map (U04). It works out what to draw from the planet's
 * look and its formed regions, builds the world after the first frame and charts it. Browsing here
 * only moves the camera and reads nothing more from the server.
 */
export function PlanetStage({
  session,
  state,
  index,
  size,
  planet,
  landed,
  selectedRegion,
  visitor,
  onRefused,
  landmarks,
}: SceneProps & {
  readonly planet: SceneDescriptor;
  readonly landed: boolean;
  readonly selectedRegion: SceneDescriptor | undefined;
  /** A friend's universe: no regions, and no landing. */
  readonly visitor?: boolean;
  /** The world could not be drawn: the screen shows the plain list of regions instead. */
  readonly onRefused: (planetId: string) => void;
  /** The landmarks standing on this planet (D-089). Never given on a friend's universe. */
  readonly landmarks?: readonly CollectionLandmark[];
}) {
  const looks = state.read.snapshot?.read.looks;
  const plan = useMemo(
    () => planPlanet(planet, index.regions.get(planet.objectId) ?? [], looksById(looks)),
    [planet, index, looks],
  );
  const palette = useMemo(() => paletteOf(plan.spec.type, plan.look?.hueShift ?? 0), [plan]);
  const globe = useGlobeWorld(session, landed ? undefined : plan.spec);
  const map = useMapWorld(session, landed ? plan.spec : undefined);
  const refused = globe.status === 'refused' || map.status === 'refused';
  useEffect(() => {
    if (refused) onRefused(planet.objectId);
  }, [refused, onRefused, planet.objectId]);
  const world = globe.status === 'ready' ? globe.world : map.status === 'ready' ? map.world : undefined;
  const chart: Chart | undefined = useMemo(() => (world ? chartWorld(world, plan.sites) : undefined), [world, plan]);
  const markers = useMemo<readonly LandmarkMarker[]>(() => {
    if (!world || !chart || !landmarks?.length) return [];
    // The first earned stands first, so a landmark never moves when another is earned.
    const ordered = [...landmarks].sort((a, b) => a.earnedAt.localeCompare(b.earnedAt) || a.key.localeCompare(b.key));
    const spots = landmarkSpots(plan.spec.seed, plan.spec.variant, world, chart, ordered.length);
    return spots.map((at, place) => ({
      key: `${ordered[place]!.assetId}:${String(ordered[place]!.revision)}`,
      tier: ordered[place]!.tier,
      at,
    }));
  }, [world, chart, landmarks, plan]);
  const hereId = state.youWereHere;
  // One function for the life of the session, so the map's memoised land does not draw again on every pan.
  const choose = useCallback((objectId: string) => void session.focus(objectId), [session]);
  const names = useMemo(
    () => new Map(plan.regions.map(({ descriptor }) => [descriptor.objectId, descriptor.label])),
    [plan],
  );
  const hereNames = useMemo(
    () => new Map(plan.regions.map(({ descriptor }) => [descriptor.objectId, regionName(descriptor, hereId)])),
    [plan, hereId],
  );
  const hypothetical = useMemo(
    () =>
      new Set(
        plan.regions
          .filter(({ descriptor }) => descriptor.truthStatus === 'hypothetical')
          .map(({ descriptor }) => descriptor.objectId),
      ),
    [plan],
  );
  if (!world || !chart) return null;
  if (world.kind === 'globe')
    return (
      <PlanetGlobe
        world={world}
        chart={chart}
        palette={palette}
        labels={names}
        size={size}
        frame={state.frame}
        reducedMotion={state.reducedMotion}
        rings={plan.look?.rings ?? false}
        moon={plan.look?.moon ?? false}
        markers={markers}
        onLand={visitor || chart.charted.length === 0 ? undefined : () => void session.land()}
        landLabel={`Land on ${planet.label}`}
      />
    );
  return (
    <PlanetMap
      world={world}
      chart={chart}
      palette={palette}
      names={names}
      accessibleNames={hereNames}
      size={size}
      frame={state.frame}
      selectedId={selectedRegion?.objectId}
      hereId={hereId ?? undefined}
      reducedMotion={state.reducedMotion}
      hypothetical={hypothetical}
      markers={markers}
      onChoose={choose}
    />
  );
}
