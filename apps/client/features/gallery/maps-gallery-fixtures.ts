import type { AvailableRegionPreview, RegionPreviewState } from '@knowscroll/client-core';
import { buildGlobe, type SceneDescriptor, type SceneLook, type WorldSpec } from '@knowscroll/scene-core';
import type { MapsGalleryParams, MapsPreviewKind } from './maps-gallery-params';

/**
 * Labelled sample data for the developer gallery's maps (`?scene=maps`) and the tests of the two map screens: one
 * planet and up to twelve regions, authored here, never product data. The planet's seed is one whose world has a
 * region across the band's seam, so the seam case can be looked at on purpose.
 */

/** A planet's world has a site for each region it can hold and four spare ones that never form (D-109). */
export const SAMPLE_SITE_COUNT = 16;
/** A 32-hex seed, as a descriptor's is; with `lush` it lays a region across the seam (the generator is pinned). */
export const SAMPLE_SEED = '9e3779b19e3779b19e3779b19e3779b1';

const id = (n: number): string => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PLANET_ID = id(1);
const SYSTEM_ID = id(2);
const regionId = (site: number): string => id(100 + site);

type Kind = SceneDescriptor['kind'];
function descriptor(
  objectId: string,
  parentId: string,
  kind: Kind,
  label: string,
  truthStatus: SceneDescriptor['truthStatus'],
): SceneDescriptor {
  return {
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId,
    parentId,
    kind,
    originTransitionId: id(9000),
    label,
    truthStatus,
    activity: { availability: 'available', state: 'active' },
    family: 'ridged.v1',
    seed: SAMPLE_SEED,
    palette: 'sage',
    material: 'solid',
    atmosphere: { density: 0.1 },
    detail: { roughness: 0.2 },
    anchor: { x: 0, y: 0, layer: 0 },
    target: { kind, objectId },
  };
}

/**
 * The site of the region that lies across the band's seam in a world: a cell whose name's place is within 40 units of
 * an edge and whose land runs past it (the generator draws land a little beyond both edges). The one nearest the edge
 * wins. Null when no region of this world is on the seam.
 */
export function seamSiteOf(spec: WorldSpec): number | null {
  const world = buildGlobe(spec);
  const width = world.width;
  let best: { site: number; distance: number } | null = null;
  for (const cell of world.cells) {
    const xs = cell.loops.flatMap((loop) => loop.filter((_, at) => at % 2 === 0));
    if (xs.length === 0 || (Math.min(...xs) >= 0 && Math.max(...xs) <= width)) continue;
    const distance = Math.min(cell.label.x, width - cell.label.x);
    if (distance <= 40 && (best === null || distance < best.distance)) best = { site: cell.site, distance };
  }
  return best?.site ?? null;
}

/** What a map screen takes, made from the gallery's choices. */
export interface MapsFixture {
  readonly planet: SceneDescriptor;
  readonly systemLabel: string;
  /** The formed regions, in site order. */
  readonly regions: readonly SceneDescriptor[];
  readonly looks: ReadonlyMap<string, SceneLook>;
  /** The region left through Open, if the params say so. */
  readonly hereId: string | null;
  /** The region map 2 shows. */
  readonly shownId: string;
  /** The region across the seam, when this planet has one. */
  readonly seamId: string | null;
}

/** The sites that have formed: the first few, with the seam region standing in for the last when it is asked for. */
function formedSites(count: number, seam: number | null): number[] {
  const sites = Array.from({ length: count }, (_, site) => site);
  if (seam !== null && !sites.includes(seam)) sites[count - 1] = seam;
  return sites.sort((a, b) => a - b);
}

/** The planet, its regions and their looks for the gallery's choices. */
export function mapsFixture(params: MapsGalleryParams): MapsFixture {
  const spec: WorldSpec = { seed: SAMPLE_SEED, type: params.type, variant: 0, siteCount: SAMPLE_SITE_COUNT };
  const seam = seamSiteOf(spec);
  const sites = formedSites(params.regions, params.seam ? seam : null);
  const planet = descriptor(PLANET_ID, SYSTEM_ID, 'planet', 'Sample planet', 'factual');
  const regions = sites.map((site, at) =>
    descriptor(
      regionId(site),
      PLANET_ID,
      'region',
      `Sample region ${at + 1}`,
      params.hypothetical && regionId(site) === shownIdOf(sites, params, seam) ? 'hypothetical' : 'factual',
    ),
  );
  const base = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1' } as const;
  const looks = new Map<string, SceneLook>([
    [
      PLANET_ID,
      {
        ...base,
        objectId: PLANET_ID,
        kind: 'planet',
        type: params.type,
        rings: false,
        moon: false,
        hueShift: 0,
        variant: 0,
        siteCount: SAMPLE_SITE_COUNT,
      },
    ],
    ...sites.map((site): [string, SceneLook] => [
      regionId(site),
      { ...base, objectId: regionId(site), kind: 'region', site },
    ]),
  ]);
  const shownId = shownIdOf(sites, params, seam);
  const hereId = params.here ? (params.map === 2 ? shownId : regions[Math.min(1, regions.length - 1)]!.objectId) : null;
  return {
    planet,
    systemLabel: 'Sample system',
    regions,
    looks,
    hereId,
    shownId,
    seamId: seam === null || !sites.includes(seam) ? null : regionId(seam),
  };
}

/** The region map 2 shows: the one across the seam when asked for (and there is one), else the first. */
function shownIdOf(sites: readonly number[], params: MapsGalleryParams, seam: number | null): string {
  return regionId(params.seam && seam !== null && sites.includes(seam) ? seam : sites[0]!);
}

/**
 * What the session's region preview says, for each state map 2 draws. Only the fields the screen reads are filled: the
 * rest of a real preview (read id, scope, geography revision) is the session's and is not shown. `blocked` is a
 * preview that loaded fine and whose Open the session refuses.
 */
export function previewOf(kind: MapsPreviewKind): RegionPreviewState {
  if (kind === 'loading') return { status: 'loading' };
  if (kind === 'offline') return { status: 'unavailable', reason: 'network' };
  if (kind === 'unavailable') return { status: 'unavailable', reason: 'no_eligible_content' };
  const scrollFirst = kind !== 'reel';
  const metadata = (format: 'scroll' | 'reel') =>
    format === 'scroll'
      ? {
          kind: 'scroll',
          title: 'Sample Scroll: how a small idea grows',
          summary: 'A short sample explanation, written for the gallery. It is not product content.',
        }
      : {
          kind: 'reel',
          title: 'Sample Reel: the same idea, in motion',
          summary: 'The same sample explanation as a Reel.',
        };
  const expected = (format: 'scroll' | 'reel', assetId: string) => ({
    assetId,
    assetRevision: 1,
    metadata: { ...metadata(format), language: 'en' },
  });
  // A real preview is validated by the contract; this carries only what the screen reads.
  return {
    status: 'available',
    preview: {
      status: 'available',
      encounter: expected(scrollFirst ? 'scroll' : 'reel', id(900)),
      alternate: expected(scrollFirst ? 'reel' : 'scroll', id(901)),
    } as unknown as AvailableRegionPreview,
  };
}
