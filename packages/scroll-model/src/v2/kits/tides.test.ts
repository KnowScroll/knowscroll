import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  combinedTide,
  describeTidesState,
  INITIAL_TIDES_STATE,
  moonPull,
  settleTidesState,
  SOLAR_SHARE_OF_LUNAR,
  tideRangeByPhase,
  TIDES_ENUMS,
  tidesParts,
  tidesPhysics,
  type TidesState,
} from './tides.js';

const PHASES = TIDES_ENUMS.moonAt;

/**
 * The tide written out again independently: the water's height round the planet is the sum of the Moon's
 * wave and the Sun's wave, each a cosine with two crests, sampled every 0.05 degrees. The kit never does
 * this; it adds two arrows. The sampled maximum is the height of the tallest bulge and where it is.
 */
function tallestBulge(moonDegrees: number, sunDegrees: number): { height: number; at: number } {
  let best = { height: -Infinity, at: 0 };
  for (let step = 0; step < 7200; step += 1) {
    const longitude = step * 0.05;
    const height =
      Math.cos((2 * (longitude - moonDegrees) * Math.PI) / 180) +
      SOLAR_SHARE_OF_LUNAR * Math.cos((2 * (longitude - sunDegrees) * Math.PI) / 180);
    if (height > best.height) best = { height, at: longitude };
  }
  return best;
}

const gapBetweenAxes = (first: number, second: number): number => {
  const gap = Math.abs(first - second) % 180;
  return Math.min(gap, 180 - gap);
};

describe('the tides physics against the sampled sum of two waves', () => {
  it('finds the height and the line of the combined bulges for any Moon and Sun', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        (moon, sun) => {
          const sampled = tallestBulge(moon, sun);
          const derived = combinedTide(moon, sun);
          expect(derived.amplitude).toBeCloseTo(sampled.height, 3);
          // When the two waves nearly cancel the crest line is not defined by the samples: judge it only when the tide is clear.
          if (derived.amplitude > 0.2) expect(gapBetweenAxes(derived.axisDegrees, sampled.at)).toBeLessThan(0.06);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('puts the Moon’s bulges on the line to the Moon whatever the Sun does, because the Moon’s wave is the stronger', () => {
    for (const phase of PHASES) {
      const physics = tidesPhysics({ moonAt: phase });
      expect(gapBetweenAxes(physics.combined.axisDegrees, physics.moonDegrees), phase).toBeLessThan(1e-9);
    }
  });

  it('adds the Sun’s wave to the Moon’s at new and full Moon and subtracts it at the quarters', () => {
    for (const phase of ['new', 'full'] as const) {
      expect(tidesPhysics({ moonAt: phase }).kind).toBe('spring');
      expect(tidesPhysics({ moonAt: phase }).combined.amplitude).toBeCloseTo(1 + SOLAR_SHARE_OF_LUNAR, 12);
    }
    for (const phase of ['first-quarter', 'last-quarter'] as const) {
      expect(tidesPhysics({ moonAt: phase }).kind).toBe('neap');
      expect(tidesPhysics({ moonAt: phase }).combined.amplitude).toBeCloseTo(1 - SOLAR_SHARE_OF_LUNAR, 12);
    }
  });

  it('is spring exactly when the Sun, the Moon and Earth are in a line, and never otherwise', () => {
    for (const phase of PHASES) {
      const physics = tidesPhysics({ moonAt: phase });
      const inLine = Math.abs(Math.sin(((physics.moonDegrees - physics.sunDegrees) * Math.PI) / 180)) < 1e-9;
      expect(physics.kind === 'spring', phase).toBe(inLine);
    }
  });

  it('draws the biggest range at spring tides, in units of the greatest, and the same at new and full', () => {
    const range = tideRangeByPhase();
    expect(range.new).toBeCloseTo(1, 12);
    expect(range.full).toBeCloseTo(1, 12);
    expect(range['first-quarter']).toBeCloseTo((1 - SOLAR_SHARE_OF_LUNAR) / (1 + SOLAR_SHARE_OF_LUNAR), 12);
    expect(range['last-quarter']).toBeCloseTo(range['first-quarter'], 12);
    for (const phase of PHASES) expect(range[phase]).toBeLessThanOrEqual(1 + 1e-12);
  });
});

describe('the Moon’s pull on three places of Earth (Newton’s inverse-square law)', () => {
  it('is strongest on the near side and weakest on the far side, by the law at a distance of sixty Earth radii', () => {
    const pull = moonPull();
    expect(pull.centre).toBe(1);
    // The same ratio written in another form: (D / (D - 1)) squared and (D / (D + 1)) squared.
    expect(pull.near).toBeCloseTo((60 / 59) ** 2, 12);
    expect(pull.far).toBeCloseTo((60 / 61) ** 2, 12);
    expect(pull.near).toBeGreaterThan(pull.centre);
    expect(pull.centre).toBeGreaterThan(pull.far);
  });

  it('leaves the two bulges about equal: the near water is pulled ahead of the centre by about as much as the far water is left behind', () => {
    const pull = moonPull();
    const towardMoon = pull.near - pull.centre;
    const awayFromMoon = pull.centre - pull.far;
    expect(towardMoon).toBeGreaterThan(0);
    expect(awayFromMoon).toBeGreaterThan(0);
    expect(towardMoon / awayFromMoon).toBeGreaterThan(1);
    expect(towardMoon / awayFromMoon).toBeLessThan(1.1);
  });
});

describe('settling and describing a tides state', () => {
  const states = TIDES_ENUMS.view.flatMap((view) =>
    PHASES.flatMap((moonAt) => TIDES_ENUMS.focus.map((focus): TidesState => ({ view, moonAt, focus }))),
  );

  it('keeps a phase only where the view draws it, and a focus only on a part that is there', () => {
    for (const state of states) {
      const settled = settleTidesState(state);
      const parts = tidesParts(state.view);
      expect(settled.moonAt).toBe(parts.includes('phase') ? state.moonAt : 'new');
      if (settled.focus === 'moon') expect(parts).toContain('moon');
      if (settled.focus === 'sun') expect(parts).toContain('sun');
      if (settled.focus === 'near-bulge' || settled.focus === 'far-bulge') expect(parts).toContain('bulges');
      if (settled.focus === 'range') expect(parts).toContain('range-bars');
    }
    expect(settleTidesState({ view: 'bulges', moonAt: 'full', focus: 'sun' })).toEqual({
      view: 'bulges',
      moonAt: 'new',
      focus: 'none',
    });
  });

  it('calls a tide spring or neap only where the Sun’s bulges are drawn, and agrees with the physics', () => {
    for (const state of states) {
      const text = describeTidesState(state);
      const settled = settleTidesState(state);
      const drawn = tidesParts(settled.view).includes('solar-bulges');
      expect(text.includes('a spring tide'), JSON.stringify(state)).toBe(
        drawn && tidesPhysics(settled).kind === 'spring',
      );
      expect(text.includes('a neap tide'), JSON.stringify(state)).toBe(drawn && tidesPhysics(settled).kind === 'neap');
    }
  });

  it('says what the bars say: tallest at new and full Moon, shortest at the quarters, with the current phase marked', () => {
    const text = describeTidesState({ view: 'range', moonAt: 'first-quarter', focus: 'none' });
    expect(text).toContain('tallest at new and full');
    expect(text).toContain('shortest at first quarter and last quarter');
    expect(text).toContain('The Moon is now at first quarter');
  });

  it('describes the Moon and the Sun only where they are drawn, and exaggeration where it is used', () => {
    expect(describeTidesState(INITIAL_TIDES_STATE)).not.toMatch(/Sun/u);
    expect(describeTidesState({ view: 'pull', moonAt: 'new', focus: 'none' })).toContain('exaggerated');
    expect(describeTidesState({ view: 'sun-moon', moonAt: 'full', focus: 'none' })).toContain('The Moon is full');
    expect(describeTidesState({ view: 'sun-moon', moonAt: 'full', focus: 'none' })).toContain('not to scale');
  });

  it('never mentions a coast, a place, a time of day or a figure', () => {
    for (const state of states)
      expect(describeTidesState(state), JSON.stringify(state)).not.toMatch(/coast|bay|harbour|hour|tonight|\d/iu);
  });
});
