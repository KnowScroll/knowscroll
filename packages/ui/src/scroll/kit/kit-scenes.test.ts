import { kitDefinition, NERVE_ENUMS, SPIKE_DURATION_MS, type NerveState } from '@knowscroll/scroll-model';
import { canTweenNerve, lerpNerveScene, nerveSceneOf } from './nerve-scene';
import { blendScenes, lerpAngle } from './blend';

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

  it('draws the start of the sodium channels opening as its own mark, and a solid arrow only while ions flow', () => {
    const at = (phase: (typeof NERVE_ENUMS.phase)[number]) => nerveSceneOf(nerve({ phase }));
    expect(at('threshold')).toMatchObject({ sodiumOpening: 1, sodiumFlows: 0 });
    expect(at('rest')).toMatchObject({ sodiumOpening: 0, sodiumFlows: 0, potassiumFlows: 0 });
    expect(at('rising')).toMatchObject({ sodiumOpening: 0, sodiumFlows: 1, potassiumFlows: 0 });
    expect(at('peak')).toMatchObject({ sodiumFlows: 1, potassiumFlows: 1 });
    expect(at('undershoot')).toMatchObject({ sodiumFlows: 0, potassiumFlows: 1 });
  });

  it('works out only the view’s own numbers: a reflex has no voltages and a spike no pushes', () => {
    expect(nerveSceneOf(nerve({ view: 'reflex' })).thresholdVoltage).toBe(0);
    expect(nerveSceneOf(nerve({ view: 'spike' })).weakCurve).toEqual([]);
    expect(nerveSceneOf(nerve({ view: 'all-or-none' })).curve).toEqual([]);
    expect(nerveSceneOf(nerve({ view: 'axon' })).profile.length).toBeGreaterThan(0);
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
