import {
  CROSSING_SEPARATION,
  GREENHOUSE_ENUMS,
  kitDefinition,
  STAR_ENUMS,
  TIDES_ENUMS,
  TRANSIT_ENUMS,
  type GreenhouseState,
  type StarState,
  type TidesState,
  type TransitState,
} from '@knowscroll/scroll-model';
import { greenhouseSceneOf, lerpGreenhouseScene, canTweenGreenhouse } from './greenhouse-scene';
import { canTweenStar, lerpStarScene, starRadiusPx, starSceneOf } from './star-scene';
import { canTweenTides, lerpTidesScene, tidesSceneOf } from './tides-scene';
import { CURVE_HALF_SPAN, CURVE_SAMPLES, canTweenTransit, lerpTransitScene, transitSceneOf } from './transit-scene';
import { blendScenes, lerpAngle } from './blend';

const tides = (patch: Partial<TidesState>): TidesState =>
  kitDefinition('tides.v1').settle({ view: 'sun-moon', moonAt: 'new', focus: 'none', ...patch }) as TidesState;
const greenhouse = (patch: Partial<GreenhouseState>): GreenhouseState =>
  kitDefinition('greenhouse.v1').settle({
    view: 'infrared',
    layer: 'thick',
    change: 'settled',
    focus: 'none',
    ...patch,
  }) as GreenhouseState;
const star = (patch: Partial<StarState>): StarState =>
  kitDefinition('star.v1').settle({
    view: 'balance',
    balance: 'steady',
    mass: 'sun-like',
    stage: 'main-sequence',
    focus: 'none',
    ...patch,
  }) as StarState;
const transit = (patch: Partial<TransitState>): TransitState =>
  kitDefinition('transit.v1').settle({
    view: 'crossing',
    planet: 'small',
    at: 'middle',
    focus: 'none',
    ...patch,
  }) as TransitState;

describe('moving a picture between two scenes', () => {
  it('blends numbers, switches words at the middle and takes the shortest way round an angle', () => {
    const from = { angle: 350, size: 10, word: 'a', list: [0, 10] };
    const to = { angle: 10, size: 20, word: 'b', list: [10, 30] };
    expect(blendScenes(from, to, 0)).toBe(from);
    expect(blendScenes(from, to, 1)).toBe(to);
    const middle = blendScenes(from, to, 0.5, ['angle']);
    expect(middle).toEqual({ angle: 360, size: 15, word: 'b', list: [5, 20] });
    expect(blendScenes(from, to, 0.25, ['angle']).word).toBe('a');
    expect(lerpAngle(350, 10, 0.5)).toBe(360);
    expect(lerpAngle(10, 350, 0.5)).toBe(0);
  });
});

describe('the tides picture agrees with the physics', () => {
  it('draws the spring tide taller than the neap tide, on the line to the Moon', () => {
    const spring = tidesSceneOf(tides({ moonAt: 'full' }));
    const neap = tidesSceneOf(tides({ moonAt: 'first-quarter' }));
    expect(spring.kind).toBe('spring');
    expect(neap.kind).toBe('neap');
    expect(spring.combinedHeight).toBeGreaterThan(1);
    expect(neap.combinedHeight).toBeLessThan(1);
    for (const scene of [spring, neap])
      expect(Math.abs(((scene.combinedAxis - scene.moonDegrees) % 180) + 360) % 180).toBeCloseTo(0, 6);
    expect(spring.sunHeight).toBeLessThan(spring.moonHeight);
  });

  it('puts the Moon on the right where the phase is not drawn, and on its phase where it is', () => {
    expect(tidesSceneOf(tides({ view: 'bulges', moonAt: 'full' })).moonDegrees).toBe(0);
    expect(tidesSceneOf(tides({ view: 'sun-moon', moonAt: 'first-quarter' })).moonDegrees).toBe(270);
    expect(tidesSceneOf(tides({ view: 'sun-moon', moonAt: 'new' })).moonDegrees).toBe(180);
  });

  it('lengthens the near pull and shortens the far one, and leaves the two differences about equal', () => {
    const scene = tidesSceneOf(tides({ view: 'pull' }));
    expect(scene.pullNear).toBeGreaterThan(1);
    expect(scene.pullFar).toBeLessThan(1);
    expect(Math.max(scene.differenceNear, scene.differenceFar)).toBe(1);
    expect(Math.min(scene.differenceNear, scene.differenceFar)).toBeGreaterThan(0.9);
  });

  it('has one bar per phase, tallest at new and full, and marks the phase shown', () => {
    const scene = tidesSceneOf(tides({ view: 'range', moonAt: 'last-quarter' }));
    expect(scene.bars).toHaveLength(TIDES_ENUMS.moonAt.length);
    expect(scene.bars[0]).toBeCloseTo(1, 9);
    expect(scene.bars[2]).toBeCloseTo(1, 9);
    expect(scene.bars[1] ?? 0).toBeLessThan(0.5);
    expect(scene.current).toBe(3);
  });

  it('moves inside one view and fades between views', () => {
    const full = tidesSceneOf(tides({ moonAt: 'full' }));
    const quarter = tidesSceneOf(tides({ moonAt: 'first-quarter' }));
    expect(canTweenTides(full, quarter)).toBe(true);
    expect(canTweenTides(full, tidesSceneOf(tides({ view: 'range' })))).toBe(false);
    const middle = lerpTidesScene(full, quarter, 0.5);
    expect(middle.combinedHeight).toBeCloseTo((full.combinedHeight + quarter.combinedHeight) / 2, 9);
    expect(lerpTidesScene(full, quarter, 1)).toBe(quarter);
  });
});

describe('the greenhouse picture agrees with the physics', () => {
  it('draws exactly the flows the energy balance gives, and never more energy out than in', () => {
    for (const layer of GREENHOUSE_ENUMS.layer)
      for (const change of GREENHOUSE_ENUMS.change) {
        const scene = greenhouseSceneOf(greenhouse({ layer, change }));
        expect(scene.toSpace).toBeLessThanOrEqual(scene.absorbed + 1e-9);
        expect(scene.passesThrough + scene.layerUp).toBeCloseTo(scene.toSpace, 9);
        expect(scene.layerUp).toBeCloseTo(scene.backDown, 9);
      }
  });

  it('draws a thicker layer thicker and more opaque, and a warmer ground for it', () => {
    const none = greenhouseSceneOf(greenhouse({ layer: 'none' }));
    const thin = greenhouseSceneOf(greenhouse({ layer: 'thin' }));
    const thick = greenhouseSceneOf(greenhouse({ layer: 'thick' }));
    expect([none.layerPx, thin.layerPx, thick.layerPx]).toEqual([0, 9, 20]);
    expect(thin.layerOpacity).toBeLessThan(thick.layerOpacity);
    expect(none.warmth).toBeLessThan(thin.warmth);
    expect(thin.warmth).toBeLessThan(thick.warmth);
  });

  it('shows the gap between energy in and out only just after the layer thickens', () => {
    expect(greenhouseSceneOf(greenhouse({ view: 'energy-balance', change: 'settled' })).imbalanced).toBe(false);
    expect(greenhouseSceneOf(greenhouse({ view: 'energy-balance', change: 'just-thickened' })).imbalanced).toBe(true);
  });

  it('moves inside one view and fades between views', () => {
    const thin = greenhouseSceneOf(greenhouse({ layer: 'thin' }));
    const thick = greenhouseSceneOf(greenhouse({ layer: 'thick' }));
    expect(canTweenGreenhouse(thin, thick)).toBe(true);
    expect(canTweenGreenhouse(thin, greenhouseSceneOf(greenhouse({ view: 'sunlight' })))).toBe(false);
    expect(lerpGreenhouseScene(thin, thick, 0.5).backDown).toBeCloseTo((thin.backDown + thick.backDown) / 2, 9);
  });
});

describe('the star picture agrees with the physics', () => {
  it('draws gravity and pressure equal when steady, and shrinks or swells the star as they say', () => {
    expect(starSceneOf(star({ balance: 'steady' }))).toMatchObject({ gravity: 1, pressure: 1, motion: 'holds' });
    expect(starSceneOf(star({ balance: 'gravity-wins' })).motion).toBe('shrinks');
    expect(starSceneOf(star({ balance: 'pressure-wins' })).motion).toBe('swells');
  });

  it('draws the bigger star for the more massive and the longer bar for the longer life', () => {
    const scene = starSceneOf(star({ view: 'mass', mass: 'high' }));
    expect(scene.radii[0] ?? 0).toBeLessThan(scene.radii[1] ?? 0);
    expect(scene.radii[1] ?? 0).toBeLessThan(scene.radii[2] ?? 0);
    expect(scene.lifetimes[0] ?? 0).toBeGreaterThan(scene.lifetimes[1] ?? 0);
    expect(scene.lifetimes[1] ?? 0).toBeGreaterThan(scene.lifetimes[2] ?? 0);
    for (const share of scene.lifetimes) {
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThanOrEqual(1);
    }
    expect(scene.markedMass).toBe(2);
    expect(starRadiusPx(1)).toBe(22);
  });

  it('draws the end that fits the mass, a giant larger than its main-sequence star and a giant red', () => {
    expect(starSceneOf(star({ view: 'life', mass: 'high', stage: 'end' })).end).toBe('supernova');
    expect(starSceneOf(star({ view: 'life', mass: 'low', stage: 'end' })).end).toBe('white-dwarf');
    for (const mass of STAR_ENUMS.mass) {
      const sequence = starSceneOf(star({ view: 'life', mass, stage: 'main-sequence' }));
      const giant = starSceneOf(star({ view: 'life', mass, stage: 'giant' }));
      expect(giant.radiusPx).toBeGreaterThan(sequence.radiusPx);
      expect(giant.surface).toBe('cool');
    }
    expect(starSceneOf(star({ view: 'life', mass: 'low', stage: 'end' })).surface).toBe('hot');
    expect(starSceneOf(star({ view: 'life', stage: 'giant' })).stageIndex).toBe(2);
  });

  it('moves inside one view and fades between views', () => {
    const steady = starSceneOf(star({ balance: 'steady' }));
    const shrinking = starSceneOf(star({ balance: 'gravity-wins' }));
    expect(canTweenStar(steady, shrinking)).toBe(true);
    expect(canTweenStar(steady, starSceneOf(star({ view: 'mass' })))).toBe(false);
    expect(lerpStarScene(steady, shrinking, 0.5).pressure).toBeCloseTo((steady.pressure + shrinking.pressure) / 2, 9);
  });
});

describe('the transit picture agrees with the physics', () => {
  it('samples the whole light curve, level at both ends and deepest in the middle by the square of the width', () => {
    for (const planet of TRANSIT_ENUMS.planet) {
      const scene = transitSceneOf(transit({ planet }));
      expect(scene.curve).toHaveLength(CURVE_SAMPLES);
      expect(scene.curve[0]).toBe(1);
      expect(scene.curve.at(-1)).toBe(1);
      expect(Math.min(...scene.curve)).toBeCloseTo(1 - scene.widthShare ** 2, 9);
      expect(scene.curve[(CURVE_SAMPLES - 1) / 2]).toBeCloseTo(1 - scene.widthShare ** 2, 9);
    }
  });

  it('marks the planet on its own curve: the brightness now is the curve at its place along the crossing', () => {
    for (const at of TRANSIT_ENUMS.at) {
      const scene = transitSceneOf(transit({ at, planet: 'large' }));
      const index = Math.round(((scene.separation + CURVE_HALF_SPAN) / (2 * CURVE_HALF_SPAN)) * (CURVE_SAMPLES - 1));
      expect(scene.separation).toBe(CROSSING_SEPARATION[at]);
      expect(scene.curve[index] ?? 0).toBeCloseTo(scene.brightness, 2);
    }
  });

  it('draws the large planet’s dip four times as deep as the small one’s, in the comparison', () => {
    const scene = transitSceneOf(transit({ view: 'compare' }));
    const depth = (curve: readonly number[]): number => 1 - Math.min(...curve);
    expect(depth(scene.largeCurve) / depth(scene.smallCurve)).toBeCloseTo(4, 6);
    expect(scene.largeWidth / scene.smallWidth).toBeCloseTo(2, 9);
  });

  it('blocks light only where the physics says, and moves inside one view', () => {
    const before = transitSceneOf(transit({ at: 'before' }));
    const middle = transitSceneOf(transit({ at: 'middle' }));
    expect(before.blocking).toBe(false);
    expect(middle.blocking).toBe(true);
    expect(canTweenTransit(before, middle)).toBe(true);
    expect(canTweenTransit(before, transitSceneOf(transit({ view: 'orbit' })))).toBe(false);
    expect(lerpTransitScene(before, middle, 0.5).brightness).toBeCloseTo(
      (before.brightness + middle.brightness) / 2,
      9,
    );
  });
});
