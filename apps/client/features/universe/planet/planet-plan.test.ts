import type { SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { indexUniverse } from '../universe-layout';
import { looksById } from '../space/space-model';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { turnHue } from './hue';
import { boxOfFormed, boxOfLoops, mapView, MAP_HEIGHT, MAP_WIDTH, toScreen } from './map-camera';
import { paletteOf } from './planet-palette';
import { planPlanet } from './planet-plan';

const world = sceneFixture(5, 0, 3);
const index = indexUniverse(world.descriptors, []);
const planet = world.descriptors.find((place) => place.objectId === fixtureId(12))!;
const regions = index.regions.get(planet.objectId) ?? [];
const looks = looksById(world.looks);

describe('what a planet is drawn from', () => {
  it('takes type, variant and sites from the look the server gave, and each region its own site', () => {
    const plan = planPlanet(planet, regions, looks);
    expect(plan.look).toBeDefined();
    expect(plan.spec).toEqual({
      seed: planet.seed,
      type: plan.look!.type,
      variant: plan.look!.variant,
      siteCount: plan.look!.siteCount,
    });
    expect(plan.regions).toHaveLength(4);
    expect(plan.sites.map((entry) => entry.site)).toEqual([0, 1, 2, 3]);
  });

  it('names the regions in site order, then by name: one order for the map and the plain list', () => {
    const shuffled = [...regions].reverse();
    const plan = planPlanet(planet, shuffled, looks);
    expect(plan.regions.map(({ descriptor }) => descriptor.objectId)).toEqual(
      [...regions]
        .sort(
          (a, b) => (looks.get(a.objectId) as { site: number }).site - (looks.get(b.objectId) as { site: number }).site,
        )
        .map((region) => region.objectId),
    );
    // A region whose look says nothing is last, by name, and has no cell.
    const bare = new Map(looks);
    bare.delete(regions[0]!.objectId);
    const partial = planPlanet(planet, regions, bare);
    expect(partial.regions.at(-1)?.descriptor.objectId).toBe(regions[0]!.objectId);
    expect(partial.regions.at(-1)?.site).toBeUndefined();
    expect(partial.sites.some((entry) => entry.objectId === regions[0]!.objectId)).toBe(false);
  });

  it('leaves out a region whose site is past the planet’s own', () => {
    const tight = new Map<string, SceneLook>(looks);
    const planetLook = looks.get(planet.objectId)!;
    tight.set(planet.objectId, { ...(planetLook as Extract<SceneLook, { kind: 'planet' }>), siteCount: 2 });
    const plan = planPlanet(planet, regions, tight);
    expect(plan.sites.map((entry) => entry.site)).toEqual([0, 1]);
  });

  it('draws a planet with no look plainly: its palette, no variant, regions on sites in the order they were made', () => {
    const plan = planPlanet(planet, regions, new Map());
    expect(plan.look).toBeUndefined();
    expect(plan.spec).toMatchObject({ seed: planet.seed, variant: 0, siteCount: 12 });
    const made = [...regions].sort((a, b) => a.objectId.localeCompare(b.objectId));
    expect(plan.regions.map(({ descriptor }) => descriptor.objectId)).toEqual(made.map((region) => region.objectId));
    // A region made later takes the next site and never moves an earlier one.
    const later: SceneDescriptor = { ...regions[0]!, objectId: fixtureId(999), label: 'Later' };
    const more = planPlanet(planet, [...regions, later], new Map());
    for (const entry of plan.regions)
      expect(more.regions.find((candidate) => candidate.descriptor === entry.descriptor)?.site).toBe(entry.site);
  });
});

describe('the colours of a planet type', () => {
  it('turns every colour but the greys, clouds and foam by the hue of the look', () => {
    const plain = paletteOf('lush', 0);
    const turned = paletteOf('lush', 75);
    expect(turned.land).not.toEqual(plain.land);
    expect(turned.sea).not.toEqual(plain.sea);
    expect(turned.grey).toEqual(plain.grey);
    expect(turned.cloud).toEqual(plain.cloud);
    expect(turned.foam).toBe(plain.foam);
    expect(paletteOf('frozen', 0).poleCaps).toBe(true);
    expect(paletteOf('scorched', 0).glowCoast).toBe(true);
    expect(paletteOf('gas', 0).bands).toHaveLength(5);
  });

  it('turns a hue by whole degrees and leaves greys and anything that is not a hex colour alone', () => {
    expect(turnHue('#ff0000', 120)).toBe('#00ff00');
    expect(turnHue('#ff0000', 240)).toBe('#0000ff');
    expect(turnHue('#ff0000', 360)).toBe('#ff0000');
    expect(turnHue('#808080', 90)).toBe('#808080');
    expect(turnHue('rgba(1,2,3,.5)', 90)).toBe('rgba(1,2,3,.5)');
    expect(turnHue('#12ab34', 0)).toBe('#12ab34');
    expect(turnHue('#ff0000', -120)).toBe('#0000ff');
  });
});

describe('the camera of the landed map', () => {
  const size = { width: 390, height: 844 };

  it('fits the whole map to the screen and moves it with the person’s pan and zoom', () => {
    const rest = mapView(size, { x: 0, y: 0, scale: 1 });
    expect(rest).toEqual({ scale: 1, x: 0, y: 0 });
    expect(toScreen(rest, MAP_WIDTH / 2, MAP_HEIGHT / 2)).toEqual({ x: 195, y: 422 });
    const panned = mapView(size, { x: 30, y: -20, scale: 2 });
    expect(panned.scale).toBe(2);
    expect(toScreen(panned, MAP_WIDTH / 2, MAP_HEIGHT / 2)).toEqual({ x: 165, y: 442 });
    const wide = mapView({ width: 974, height: 900 }, { x: 0, y: 0, scale: 1 });
    expect(wide.scale).toBeCloseTo(900 / 844, 10);
    expect(toScreen(wide, MAP_WIDTH / 2, MAP_HEIGHT / 2).x).toBeCloseTo(487, 6);
  });

  it('drops about twice as close over a chosen region and centres it above the card', () => {
    const chosen = { x0: 100, y0: 300, x1: 200, y1: 420 };
    const view = mapView(size, { x: 0, y: 0, scale: 1 }, chosen);
    expect(view.scale).toBeGreaterThanOrEqual(1.6);
    expect(view.scale).toBeLessThanOrEqual(2.1);
    const middle = toScreen(view, 150, 360);
    expect(middle.x).toBeCloseTo(195, 6);
    expect(middle.y).toBeCloseTo(((112 + 520) / 2 + 6) * (844 / 844), 6);
    // A huge region does not drop below the least zoom, and a tiny one does not go past the most.
    expect(mapView(size, { x: 0, y: 0, scale: 1 }, { x0: 0, y0: 0, x1: 900, y1: 900 }).scale).toBe(1.6);
    expect(mapView(size, { x: 0, y: 0, scale: 1 }, { x0: 0, y0: 0, x1: 10, y1: 10 }).scale).toBe(2.1);
  });

  it('opens centred on the formed regions and their names, shrinking a little to take them all in', () => {
    const cells = [
      { loops: [[250, 300, 380, 300, 380, 420, 250, 420]], label: { x: 300, y: 350 } },
      { loops: [[260, 450, 330, 450, 330, 520, 260, 520]], label: { x: 295, y: 480 } },
    ];
    const formed = boxOfFormed(cells)!;
    expect(formed).toEqual({ x0: 250, y0: 300, x1: 380, y1: 520 });
    const view = mapView(size, { x: 0, y: 0, scale: 1 }, undefined, formed);
    const middle = toScreen(view, 315, 410);
    expect(middle.x).toBeCloseTo(195, 6);
    expect(middle.y).toBeCloseTo(422, 6);
    // Every corner of the formed box, with the room for names, is inside the screen.
    const corner = toScreen(view, 250 - 56, 300 - 96);
    const far = toScreen(view, 380 + 56, 520 + 96);
    for (const point of [corner, far]) {
      expect(point.x).toBeGreaterThanOrEqual(-0.001);
      expect(point.x).toBeLessThanOrEqual(390.001);
    }
    expect(view.scale).toBeLessThanOrEqual(1);
    // Nothing formed: the whole map, as before.
    expect(boxOfFormed([])).toBeUndefined();
    expect(mapView(size, { x: 0, y: 0, scale: 1 }, undefined, undefined)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('boxes the biggest loop of a region', () => {
    expect(boxOfLoops([])).toBeUndefined();
    expect(
      boxOfLoops([
        [0, 0, 1, 1, 2, 0],
        [10, 20, 30, 40, 50, 60, 70, 80],
      ]),
    ).toEqual({ x0: 10, y0: 20, x1: 70, y1: 80 });
  });
});
