import { useMemo } from 'react';
import { chartWorld, type Chart, type GlobeWorld, type SceneDescriptor, type SceneLook } from '@knowscroll/scene-core';
import { paletteOf, type PlanetPalette } from '../../planet/planet-palette';
import { planPlanet, type PlanetPlan } from '../../planet/planet-plan';
import { useGlobeWorld } from '../../planet/use-planet-world';

/** What the flat drawing of a planet is made from, once its world is built. */
export interface FlatPlanetWorld {
  readonly world: GlobeWorld;
  /** Which land has formed: the cells that are named and chosen, and the land that is not reached, as outlines only. */
  readonly chart: Chart;
  /** The name of each formed region, by id. Nothing here for land that is not reached. */
  readonly names: ReadonlyMap<string, string>;
}

/** Where the drawing of the planet has got to: the plan is always there, the world is built after the first frame. */
export interface FlatPlanetState {
  /** The planet's regions in map order, which is also the order of the list under the map. Ready on the first render. */
  readonly plan: PlanetPlan;
  /** The planet's colours, from its type and hue alone, so the list's swatches are there before the world is. */
  readonly palette: PlanetPalette;
  readonly status: 'drawing' | 'refused' | 'ready';
  /** Set only when `status` is `ready`. */
  readonly flat: FlatPlanetWorld | null;
}

/**
 * Works out what the map of a planet draws: the plan of its regions, then its globe world (the very band the ground
 * and the globe are painted from, so a region is at the same place on the map as on the ground), charted by the regions
 * that have formed, and the palette. The world is built after the first frame and kept by `session`
 * (`useGlobeWorld`), so with the stage already showing this planet it is a cache hit. The plan does not wait for the
 * world: the list under the map needs only the plan, so it is there at once, and stays if the world cannot be built.
 *
 * `regions` are the formed regions of this planet and nothing else (what the universe's index holds, D-109).
 *
 * The stage's own planet surface (`usePlanetSurface` in `voyage-stage.tsx`) does the same work for a visitor and with
 * landmarks; this is its smaller twin for a person's own planet, and the two can share one function when that file is
 * next open.
 */
export function useFlatPlanet(
  session: object,
  planet: SceneDescriptor,
  regions: readonly SceneDescriptor[],
  looks: ReadonlyMap<string, SceneLook>,
): FlatPlanetState {
  const plan = useMemo(() => planPlanet(planet, regions, looks), [planet, regions, looks]);
  const globe = useGlobeWorld(session, plan.spec);
  const palette = useMemo(() => paletteOf(plan.spec.type, plan.look?.hueShift ?? 0), [plan]);
  return useMemo((): FlatPlanetState => {
    if (globe.status !== 'ready') return { plan, palette, status: globe.status, flat: null };
    return {
      plan,
      palette,
      status: 'ready',
      flat: {
        world: globe.world,
        chart: chartWorld(globe.world, plan.sites),
        names: new Map(regions.map((region) => [region.objectId, region.label])),
      },
    };
  }, [plan, palette, globe, regions]);
}
