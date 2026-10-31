import {
  CIRCULATION_ENUMS,
  CROSSING_SEPARATION,
  GREENHOUSE_ENUMS,
  kitDefinition,
  NERVE_ENUMS,
  SPIKE_DURATION_MS,
  STAR_ENUMS,
  TIDES_ENUMS,
  TRANSIT_ENUMS,
  type CirculationState,
  type GreenhouseState,
  type NerveState,
  type StarState,
  type TidesState,
  type TransitState,
} from '@knowscroll/scroll-model';
import {
  CURVE_SAMPLES as CIRCULATION_CURVE_SAMPLES,
  canTweenCirculation,
  circulationSceneOf,
  lerpCirculationScene,
} from './circulation-scene';
import { canTweenNerve, lerpNerveScene, nerveSceneOf } from './nerve-scene';
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

const circulation = (patch: Partial<CirculationState>): CirculationState =>
  kitDefinition('circulation.v1').settle({
    view: 'heart',
    phase: 'filling',
    flow: 'usual',
    vessels: 'usual',
    where: 'lungs',
    focus: 'none',
    ...patch,
  }) as CirculationState;

describe('the circulation picture agrees with the physics', () => {
  it('draws a valve open exactly where the pressure behind it is above the pressure ahead of it, and keeps the two sets apart', () => {
    for (const phase of CIRCULATION_ENUMS.phase) {
      const scene = circulationSceneOf(circulation({ phase }));
      expect(scene.atrioventricularOpen === 1).toBe(scene.atriumPressure > scene.ventriclePressure);
      expect(scene.semilunarOpen === 1).toBe(scene.ventriclePressure > scene.arteryPressure);
      expect(scene.atrioventricularOpen + scene.semilunarOpen).toBeLessThanOrEqual(1);
      expect(scene.atriaSqueeze + scene.ventriclesSqueeze).toBeLessThanOrEqual(1);
    }
  });

  it('scales every state of the loop against the same highest pressure and starts the fall at the arteries', () => {
    for (const flow of CIRCULATION_ENUMS.flow)
      for (const vessels of CIRCULATION_ENUMS.vessels) {
        const scene = circulationSceneOf(circulation({ view: 'pressure', flow, vessels }));
        expect(scene.levels).toHaveLength(5);
        expect(scene.levels[4]).toBe(0);
        scene.levels.slice(1).forEach((level, index) => expect(level).toBeLessThan(scene.levels[index] ?? 0));
        expect(Math.max(...scene.levels)).toBeLessThanOrEqual(1 + 1e-12);
      }
    const highest = circulationSceneOf(circulation({ view: 'pressure', flow: 'more', vessels: 'narrowed' }));
    expect(highest.levels[0]).toBeCloseTo(1, 12);
    const usual = circulationSceneOf(circulation({ view: 'pressure' }));
    expect(usual.levels).toEqual(usual.usualLevels);
  });

  it('puts the blood on the curve where its oxygen is: the lungs high, tissue lower, and more handed over in working tissue', () => {
    const lungs = circulationSceneOf(circulation({ view: 'oxygen', where: 'lungs' }));
    const resting = circulationSceneOf(circulation({ view: 'oxygen', where: 'resting-tissue' }));
    const working = circulationSceneOf(circulation({ view: 'oxygen', where: 'active-tissue' }));
    expect(lungs.curve).toHaveLength(CIRCULATION_CURVE_SAMPLES);
    for (const scene of [lungs, resting, working]) {
      const index = Math.round(scene.hereAt * (CIRCULATION_CURVE_SAMPLES - 1));
      expect(scene.curve[index] ?? 0).toBeCloseTo(scene.hereLoaded, 1);
      expect(scene.lungsLoaded).toBe(lungs.lungsLoaded);
    }
    expect(lungs.handedOver).toBe(0);
    expect(resting.lungsLoaded - resting.hereLoaded).toBeLessThan(working.lungsLoaded - working.hereLoaded);
    expect(working.hereAt).toBeLessThan(resting.hereAt);
  });

  it('moves inside one view and fades between views', () => {
    const filling = circulationSceneOf(circulation({ phase: 'filling' }));
    const ejection = circulationSceneOf(circulation({ phase: 'ejection' }));
    expect(canTweenCirculation(filling, ejection)).toBe(true);
    expect(canTweenCirculation(filling, circulationSceneOf(circulation({ view: 'circuits' })))).toBe(false);
    expect(lerpCirculationScene(filling, ejection, 0.5).semilunarOpen).toBe(0.5);
  });
});

const nerve = (patch: Partial<NerveState>): NerveState =>
  kitDefinition('nerve.v1').settle({
    view: 'spike',
    phase: 'rest',
    along: 'start',
    synapseAt: 'arrives',
    effect: 'excite',
    arcAt: 'sensor',
    focus: 'none',
    ...patch,
  }) as NerveState;

describe('the nerve picture agrees with the physics', () => {
  it('samples the spike and puts its marker on the point the state names', () => {
    const phases = NERVE_ENUMS.phase.map((phase) => nerveSceneOf(nerve({ phase })));
    for (const scene of phases) {
      expect(scene.curve).toHaveLength(Math.round(SPIKE_DURATION_MS / 0.1) + 1);
      expect(Math.max(...scene.curve)).toBeCloseTo(scene.peakVoltage, 0);
    }
    const times = phases.map((scene) => scene.markerTime);
    times.slice(1).forEach((time, index) => expect(time).toBeGreaterThan(times[index] ?? 0));
    const at = (phase: (typeof NERVE_ENUMS.phase)[number]) => phases[NERVE_ENUMS.phase.indexOf(phase)];
    expect(at('peak')?.sodiumOpen ?? 0).toBeGreaterThan(at('rest')?.sodiumOpen ?? 1);
    expect(at('undershoot')?.sodiumShut).toBe(1);
    expect(at('rest')?.sodiumShut).toBe(0);
    expect(at('falling')?.potassiumOpen ?? 0).toBeGreaterThan(at('rest')?.potassiumOpen ?? 1);
  });

  it('draws the three pushes: a weak one that stays under the threshold and two stronger spikes of about one height', () => {
    const scene = nerveSceneOf(nerve({ view: 'all-or-none' }));
    expect(Math.max(...scene.weakCurve)).toBeLessThan(scene.thresholdVoltage);
    expect(Math.abs(Math.max(...scene.enoughCurve) - Math.max(...scene.strongCurve))).toBeLessThan(
      0.1 * (scene.peakVoltage - scene.restVoltage),
    );
  });

  it('puts the spike where the state says along the axon, with the recovering stretch behind it', () => {
    const places = NERVE_ENUMS.along.map((along) => nerveSceneOf(nerve({ view: 'axon', along })));
    places.slice(1).forEach((scene, index) => expect(scene.peakAt).toBeGreaterThan(places[index]?.peakAt ?? 1));
    const scene = places[0];
    const peakIndex = Math.round((scene?.peakShare ?? 0) * ((scene?.profile.length ?? 1) - 1));
    expect(scene?.recovering[peakIndex - 1]).toBe(1);
    expect(scene?.recovering[peakIndex + 1]).toBe(0);
  });

  it('moves the next cell toward the threshold for excite and away for inhibit, and only once the receptors open', () => {
    const shift = (effect: NerveState['effect'], synapseAt: NerveState['synapseAt']) =>
      nerveSceneOf(nerve({ view: 'synapse', synapseAt, effect })).shift;
    expect(shift('excite', 'release')).toBe(0);
    expect(shift('excite', 'binding')).toBeGreaterThan(0);
    expect(shift('inhibit', 'binding')).toBeLessThan(0);
    expect(shift('excite', 'clearing')).toBeLessThan(shift('excite', 'binding'));
    expect(nerveSceneOf(nerve({ view: 'synapse', synapseAt: 'binding' })).synapseTime).toBe(1);
  });

  it('lights the reflex up to the step, tells the brain last, and moves inside one view', () => {
    const steps = NERVE_ENUMS.arcAt.map((arcAt) => nerveSceneOf(nerve({ view: 'reflex', arcAt })));
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('the reflex has several steps');
    expect(steps[NERVE_ENUMS.arcAt.indexOf('muscle')]).toMatchObject({ muscleLit: 1, brainLit: 0, newsOnItsWay: 1 });
    expect(steps[NERVE_ENUMS.arcAt.indexOf('brain')]).toMatchObject({ brainLit: 1, newsOnItsWay: 0 });
    expect(first).toMatchObject({ sensorLit: 1, sensoryLit: 0, cordLit: 0 });
    expect(canTweenNerve(first, second)).toBe(true);
    expect(canTweenNerve(first, nerveSceneOf(nerve({ view: 'axon' })))).toBe(false);
    expect(lerpNerveScene(first, second, 0.5).sensoryLit).toBe(0.5);
  });
});
