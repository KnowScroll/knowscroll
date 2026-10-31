import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  brightnessAt,
  coveredShare,
  CROSSING_SEPARATION,
  describeTransitState,
  ORBIT_RADIUS_IN_STAR_RADII,
  orbitDegreesAt,
  PLANET_WIDTH_SHARE,
  settleTransitState,
  TRANSIT_ENUMS,
  transitDepth,
  transitParts,
  transitPhysics,
  type TransitState,
} from './transit.js';

/**
 * The share of the star the planet covers, written out again independently: the star and the planet are
 * two discs; slice them into thin vertical strips and add up the length of each strip that lies in both.
 * The kit never does this: it has the closed form for the overlap of two circles.
 */
function coveredByStrips(widthShare: number, separation: number): number {
  const strips = 40_000;
  const left = Math.max(-1, separation - widthShare);
  const right = Math.min(1, separation + widthShare);
  if (right <= left) return 0;
  const step = (right - left) / strips;
  let area = 0;
  for (let strip = 0; strip < strips; strip += 1) {
    const x = left + (strip + 0.5) * step;
    const star = Math.sqrt(Math.max(0, 1 - x * x));
    const planet = Math.sqrt(Math.max(0, widthShare * widthShare - (x - separation) ** 2));
    const overlap = Math.min(star, planet) * 2;
    area += overlap * step;
  }
  return area / Math.PI;
}

describe('the transit physics against slices of two discs', () => {
  it('covers as much of the star as the strips add up to, for any planet width and any place along the crossing', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.02, max: 0.6, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        (widthShare, separation) => {
          expect(coveredShare(widthShare, separation)).toBeCloseTo(coveredByStrips(widthShare, separation), 4);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('makes the deepest dip the square of the planet’s width against the star’s, with it wholly in front', () => {
    for (const planet of TRANSIT_ENUMS.planet) {
      const width = PLANET_WIDTH_SHARE[planet];
      expect(coveredShare(width, 0), planet).toBeCloseTo(width * width, 12);
      expect(transitDepth(width), planet).toBeCloseTo(coveredByStrips(width, 0), 4);
    }
    expect(transitDepth(PLANET_WIDTH_SHARE.large) / transitDepth(PLANET_WIDTH_SHARE.small)).toBeCloseTo(4, 12);
    expect(PLANET_WIDTH_SHARE.large / PLANET_WIDTH_SHARE.small).toBeCloseTo(2, 12);
  });

  it('is level away from the star, dips as the planet enters, is deepest in the middle and is the same on the way out', () => {
    for (const planet of TRANSIT_ENUMS.planet) {
      const width = PLANET_WIDTH_SHARE[planet];
      expect(brightnessAt(width, -3)).toBe(1);
      expect(brightnessAt(width, 3)).toBe(1);
      let previous = 1;
      for (let separation = 3; separation >= 0; separation -= 0.05) {
        const brightness = brightnessAt(width, separation);
        expect(brightness).toBeLessThanOrEqual(previous + 1e-8);
        expect(brightnessAt(width, -separation)).toBeCloseTo(brightness, 12);
        previous = brightness;
      }
      expect(brightnessAt(width, 0)).toBeCloseTo(1 - transitDepth(width), 12);
    }
  });

  it('blocks light exactly from the first touch to the last, and a larger planet blocks more at every place', () => {
    for (const place of TRANSIT_ENUMS.at) {
      for (const planet of TRANSIT_ENUMS.planet)
        expect(transitPhysics({ planet, at: place }).blocking, `${planet} ${place}`).toBe(
          ['ingress', 'middle', 'egress'].includes(place),
        );
      expect(transitPhysics({ planet: 'large', at: place }).covered).toBeGreaterThanOrEqual(
        transitPhysics({ planet: 'small', at: place }).covered,
      );
    }
  });

  it('puts the planet on its orbit where its crossing says: its sideways distance is the orbit’s radius times the sine of the angle', () => {
    for (const place of TRANSIT_ENUMS.at)
      expect(ORBIT_RADIUS_IN_STAR_RADII * Math.sin((orbitDegreesAt(place) * Math.PI) / 180), place).toBeCloseTo(
        CROSSING_SEPARATION[place],
        12,
      );
    expect(orbitDegreesAt('middle')).toBe(0);
    expect(orbitDegreesAt('before')).toBeLessThan(orbitDegreesAt('ingress'));
  });
});

describe('settling and describing a transit state', () => {
  const states = TRANSIT_ENUMS.view.flatMap((view) =>
    TRANSIT_ENUMS.planet.flatMap((planet) =>
      TRANSIT_ENUMS.at.flatMap((at) => TRANSIT_ENUMS.focus.map((focus): TransitState => ({ view, planet, at, focus }))),
    ),
  );

  it('compares both planets together, so it keeps neither one planet nor a place', () => {
    for (const state of states) {
      const settled = settleTransitState(state);
      if (state.view === 'compare') expect(settled).toMatchObject({ planet: 'small', at: 'before' });
      else expect(settled).toMatchObject({ planet: state.planet, at: state.at });
      if (settled.focus === 'dip') expect(transitParts(settled.view)).toContain('dip');
      if (settled.focus !== 'none') expect(transitParts(settled.view)).toContain(settled.focus);
    }
    expect(settleTransitState({ view: 'orbit', planet: 'large', at: 'middle', focus: 'dip' }).focus).toBe('none');
    // The comparison draws two graphs and the two planets, and no star disc, so there is no star to look at.
    expect(settleTransitState({ view: 'compare', planet: 'small', at: 'before', focus: 'star' }).focus).toBe('none');
    expect(settleTransitState({ view: 'compare', planet: 'small', at: 'before', focus: 'planet' }).focus).toBe(
      'planet',
    );
  });

  it('says a planet blocks light exactly where the physics says it does', () => {
    for (const state of states) {
      const settled = settleTransitState(state);
      if (settled.view === 'compare') continue;
      const text = describeTransitState(state);
      const blocking = transitPhysics(settled).blocking;
      expect(text.includes('blocks none of its light'), JSON.stringify(state)).toBe(!blocking);
      expect(
        text.includes('blocks a little of its light') || text.includes('blocks as much light as it ever does'),
      ).toBe(blocking);
    }
  });

  it('says the large planet is twice as wide and its dip four times as deep, as the sizes it draws are', () => {
    const text = describeTransitState({ view: 'compare', planet: 'small', at: 'before', focus: 'none' });
    expect(text).toContain('twice as wide');
    expect(text).toContain('four times as deep');
    expect(text).toContain('illustrative');
  });

  it('says the dip is enlarged wherever a graph is drawn, and gives no real planet, no star name and no figure', () => {
    for (const state of states) {
      const text = describeTransitState(state);
      if (settleTransitState(state).view !== 'orbit') expect(text, JSON.stringify(state)).toContain('enlarged');
      expect(text, JSON.stringify(state)).not.toMatch(/Kepler|TESS|Jupiter|Earth|\d/u);
    }
  });
});
