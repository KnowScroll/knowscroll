import { PLANET_TYPES, type PlanetType } from '@knowscroll/scene-core';

/** The states of a region's preview that the gallery can show on map 2. */
export type MapsPreviewKind = 'scroll' | 'reel' | 'loading' | 'offline' | 'unavailable' | 'blocked';
const PREVIEWS: readonly MapsPreviewKind[] = ['scroll', 'reel', 'loading', 'offline', 'unavailable', 'blocked'];

/** What `/gallery-space?scene=maps` reads from its address. */
export interface MapsGalleryParams {
  /** 1: the whole planet. 2: one region's own map. */
  readonly map: 1 | 2;
  /** How many regions have formed, 1 to 12. */
  readonly regions: number;
  /** A region stands on the band's seam. On map 2 it is the region shown. */
  readonly seam: boolean;
  /** One region is marked "you were here". */
  readonly here: boolean;
  /** Map 2: what the region's preview says. */
  readonly preview: MapsPreviewKind;
  /** The region shown on map 2 is hypothetical. */
  readonly hypothetical: boolean;
  readonly type: PlanetType;
}

type Raw = Readonly<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The most regions a sample planet forms: its world has four more sites that never become a region. */
export const MOST_REGIONS = 12;

/**
 * Reads `map` (1 or 2), `regions` (1 to 12, default 4), `seam=1`, `here=1`, `preview` (`scroll`, `reel`, `loading`,
 * `offline`, `unavailable`, `blocked`; default `scroll`), `hypothetical=1` and `type` (a planet type, default `lush`).
 * Anything else falls back to the default.
 */
export function readMapsParams(raw: Raw): MapsGalleryParams {
  const regions = Number(first(raw['regions']));
  const preview = first(raw['preview']);
  const type = first(raw['type']);
  return {
    map: first(raw['map']) === '2' ? 2 : 1,
    regions: Number.isInteger(regions) && regions >= 1 && regions <= MOST_REGIONS ? regions : 4,
    seam: first(raw['seam']) === '1',
    here: first(raw['here']) === '1',
    preview: PREVIEWS.find((kind) => kind === preview) ?? 'scroll',
    hypothetical: first(raw['hypothetical']) === '1',
    type: PLANET_TYPES.find((known) => known === type) ?? 'lush',
  };
}
