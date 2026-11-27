import { buildGlobe, chartWorld } from '@knowscroll/scene-core';
import { mapsFixture, previewOf, SAMPLE_SEED, SAMPLE_SITE_COUNT, seamSiteOf } from './maps-gallery-fixtures';
import { readMapsParams } from './maps-gallery-params';

const fixture = (query: Record<string, string> = {}) => mapsFixture(readMapsParams(query));

describe('the sample planet of the maps gallery', () => {
  it('has a region across the band’s seam, and the generator’s own cell for it runs past the edge', () => {
    const spec = { seed: SAMPLE_SEED, type: 'lush', variant: 0, siteCount: SAMPLE_SITE_COUNT } as const;
    const site = seamSiteOf(spec);
    expect(site).not.toBeNull();
    const world = buildGlobe(spec);
    const xs = world.cells[site!]!.loops.flatMap((loop) => loop.filter((_, at) => at % 2 === 0));
    expect(Math.min(...xs) < 0 || Math.max(...xs) > world.width).toBe(true);
  });

  it.each([1, 4, 12])('forms %i regions, each with its own site, and leaves four spare sites', (count) => {
    const { regions, looks, planet } = fixture({ regions: String(count) });
    expect(regions).toHaveLength(count);
    const sites = regions.map((region) => {
      const look = looks.get(region.objectId);
      return look?.kind === 'region' ? look.site : -1;
    });
    expect(new Set(sites).size).toBe(count);
    expect(Math.min(...sites)).toBeGreaterThanOrEqual(0);
    // The first sites form in turn; at most twelve of the sixteen, so four are always spare.
    expect(Math.max(...sites)).toBe(count - 1);
    expect(looks.get(planet.objectId)).toMatchObject({ kind: 'planet', siteCount: SAMPLE_SITE_COUNT });
    // Every formed region has a cell to draw.
    const world = buildGlobe({ seed: SAMPLE_SEED, type: 'lush', variant: 0, siteCount: SAMPLE_SITE_COUNT });
    expect(
      chartWorld(
        world,
        sites.map((site, at) => ({ objectId: regions[at]!.objectId, site })),
      ).charted,
    ).toHaveLength(count);
  });

  it('puts the seam region among the formed ones and shows it on map 2 when the seam is asked for', () => {
    for (const regions of ['1', '4', '12']) {
      const { seamId, shownId, regions: formed } = fixture({ regions, seam: '1', map: '2' });
      expect(seamId).not.toBeNull();
      expect(formed.map((region) => region.objectId)).toContain(seamId);
      expect(shownId).toBe(seamId);
    }
  });

  it('marks one region "you were here" only when asked, and the one shown on map 2', () => {
    expect(fixture().hereId).toBeNull();
    const one = fixture({ here: '1' });
    expect(one.hereId).toBe(one.regions[1]!.objectId);
    const two = fixture({ here: '1', map: '2' });
    expect(two.hereId).toBe(two.shownId);
    expect(fixture({ here: '1', regions: '1' }).hereId).toBe(fixture({ regions: '1' }).regions[0]!.objectId);
  });

  it('makes the shown region hypothetical on request', () => {
    const { regions, shownId } = fixture({ hypothetical: '1', map: '2' });
    expect(regions.filter((region) => region.truthStatus === 'hypothetical').map((region) => region.objectId)).toEqual([
      shownId,
    ]);
  });
});

describe('the sample previews', () => {
  it('has a Scroll with its Reel twin, a Reel with its Scroll twin, and the three states with none', () => {
    const scroll = previewOf('scroll').preview!;
    expect(scroll.encounter.metadata.kind).toBe('scroll');
    expect(scroll.alternate?.metadata.kind).toBe('reel');
    const reel = previewOf('reel').preview!;
    expect(reel.encounter.metadata.kind).toBe('reel');
    expect(reel.alternate?.metadata.kind).toBe('scroll');
    expect(previewOf('loading')).toEqual({ status: 'loading' });
    expect(previewOf('offline')).toEqual({ status: 'unavailable', reason: 'network' });
    expect(previewOf('unavailable').preview).toBeUndefined();
  });
});
