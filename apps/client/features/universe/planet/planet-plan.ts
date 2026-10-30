import type { PlanetLook, RegionSite, SceneDescriptor, SceneLook, WorldSpec } from '@knowscroll/scene-core';
import { PLAIN_TYPE } from '../space/space-model';

/** A region of a planet, with the site its cell grows from (undefined: it has no look to say). */
export interface PlannedRegion {
  readonly descriptor: SceneDescriptor;
  readonly site: number | undefined;
}

/** What a planet's globe and map are drawn from, and the regions in the order the map names them. */
export interface PlanetPlan {
  readonly spec: WorldSpec;
  readonly look: PlanetLook | undefined;
  /**
   * Formed regions in map order: by site, then by name. The targets on the map and the rows of the
   * plain list use this one order, so the drawing and the Simple drawing name the same places the same way.
   */
  readonly regions: readonly PlannedRegion[];
  /** The regions that have a cell, for charting a world. */
  readonly sites: readonly RegionSite[];
}

/** Sites a planet without a look is given: room for every region the catalogue can hold, and more. */
const PLAIN_SITES = 12;

const byName = (a: SceneDescriptor, b: SceneDescriptor) =>
  a.label.localeCompare(b.label) || a.objectId.localeCompare(b.objectId);

/**
 * Works out what to draw for one planet. The look the server gave (D-102) decides the type, hue,
 * variant and sites. A planet without a look (a friend's visit, a world not backfilled yet) is
 * drawn plainly from its palette, its regions taking sites in the order they were created, so a
 * later region never moves an earlier one.
 */
export function planPlanet(
  planet: SceneDescriptor,
  regions: readonly SceneDescriptor[],
  looks: ReadonlyMap<string, SceneLook>,
): PlanetPlan {
  const planetLook = looks.get(planet.objectId);
  const look = planetLook?.kind === 'planet' ? planetLook : undefined;
  const spec: WorldSpec = look
    ? { seed: planet.seed, type: look.type, variant: look.variant, siteCount: look.siteCount }
    : { seed: planet.seed, type: PLAIN_TYPE[planet.palette], variant: 0, siteCount: PLAIN_SITES };
  const creationOrder = [...regions].sort((a, b) => a.objectId.localeCompare(b.objectId));
  const planned: PlannedRegion[] = regions.map((descriptor) => {
    if (!look) return { descriptor, site: creationOrder.indexOf(descriptor) };
    const regionLook = looks.get(descriptor.objectId);
    return { descriptor, site: regionLook?.kind === 'region' ? regionLook.site : undefined };
  });
  planned.sort(
    (a, b) =>
      (a.site ?? Number.MAX_SAFE_INTEGER) - (b.site ?? Number.MAX_SAFE_INTEGER) || byName(a.descriptor, b.descriptor),
  );
  const sites = planned.flatMap(({ descriptor, site }) =>
    site === undefined || site >= spec.siteCount ? [] : [{ objectId: descriptor.objectId, site }],
  );
  return { spec, look, regions: planned, sites };
}
