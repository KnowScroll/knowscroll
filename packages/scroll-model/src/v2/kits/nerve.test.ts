import { describe, expect, it } from 'vitest';
import {
  actionPotential,
  arcPhysics,
  ARC_LINKS,
  AXON_PEAK_AT,
  AXON_PROFILE_SAMPLES,
  axonProfile,
  channelsAtIndex,
  describeNerveState,
  freshPushFiresAt,
  INITIAL_NERVE_STATE,
  NERVE_ENUMS,
  nerveParts,
  PUSH_END,
  PUSH_START,
  pushResponses,
  settleNerveState,
  spikePhysics,
  synapsePhysics,
  synapticShift,
  type NerveState,
  type SpikePhase,
} from './nerve.js';
import {
  membraneAtRest,
  POTASSIUM_REVERSAL,
  runMembrane,
  SODIUM_REVERSAL,
  TRACE_STEP,
  timeOf,
  type MembraneState,
} from './membrane.js';

/**
 * The membrane written again with the simplest method there is: forward Euler with a step twenty times finer than
 * the kit's. The kit integrates with fourth-order Runge-Kutta, so agreement between the two is not an accident of
 * one method. The equations and constants are those of Hodgkin and Huxley's paper, with the modern sign.
 */
function eulerSpike(current: number, duration: number): number[] {
  const step = 0.0005;
  let voltage = -65;
  let [m, h, n] = [0.0529, 0.5961, 0.3177];
  const out: number[] = [];
  const x = (value: number, scale: number, atZero: number) =>
    Math.abs(value) < 1e-7 ? atZero : value / (1 - Math.exp(-value / scale));
  for (let time = 0; time < duration; time += step) {
    const injected = time >= PUSH_START && time < PUSH_END ? current : 0;
    const ionic = 120 * m ** 3 * h * (voltage - 50) + 36 * n ** 4 * (voltage + 77) + 0.3 * (voltage + 54.387);
    const dm = 0.1 * x(voltage + 40, 10, 10) * (1 - m) - 4 * Math.exp(-(voltage + 65) / 18) * m;
    const dh = 0.07 * Math.exp(-(voltage + 65) / 20) * (1 - h) - (1 / (1 + Math.exp(-(voltage + 35) / 10))) * h;
    const dn = 0.01 * x(voltage + 55, 10, 10) * (1 - n) - 0.125 * Math.exp(-(voltage + 65) / 80) * n;
    voltage += step * (injected - ionic);
    m += step * dm;
    h += step * dh;
    n += step * dn;
    out.push(voltage);
  }
  return out;
}

describe('the spike against an independent integration of the membrane equations', () => {
  const spike = actionPotential();

  it('has the same peak, at the same time, as a forward-Euler run twenty times finer', () => {
    const euler = eulerSpike(spike.pushCurrent.enough, 16);
    const eulerPeak = Math.max(...euler);
    const eulerPeakTime = (euler.indexOf(eulerPeak) + 1) * 0.0005;
    expect(Math.abs(spike.peakVoltage - eulerPeak)).toBeLessThan(1);
    expect(Math.abs(timeOf(spike.phaseIndex.peak) - eulerPeakTime)).toBeLessThan(0.1);
    expect(Math.abs(spike.undershootVoltage - Math.min(...euler))).toBeLessThan(1);
  });

  it('rests, peaks and dips below rest where the published model does', () => {
    expect(spike.restVoltage).toBeGreaterThan(-66);
    expect(spike.restVoltage).toBeLessThan(-64);
    expect(spike.peakVoltage).toBeGreaterThan(30);
    expect(spike.peakVoltage).toBeLessThan(50);
    expect(spike.undershootVoltage).toBeLessThan(spike.restVoltage - 5);
    expect(spike.undershootVoltage).toBeGreaterThan(POTASSIUM_REVERSAL);
    // The threshold lies between rest and the point of no return, a few millivolts above rest.
    expect(spike.thresholdVoltage).toBeGreaterThan(spike.restVoltage + 3);
    expect(spike.thresholdVoltage).toBeLessThan(spike.restVoltage + 12);
  });

  it('never goes above the sodium reversal voltage or below the potassium one', () => {
    for (const state of spike.trace.states) {
      expect(state.voltage).toBeLessThan(SODIUM_REVERSAL);
      expect(state.voltage).toBeGreaterThan(POTASSIUM_REVERSAL);
    }
  });

  it('fires from a sudden lift just above the threshold and not from one just below it', () => {
    const rest = membraneAtRest();
    const lifted = (voltage: number): MembraneState => ({ ...rest, voltage });
    const peakOf = (voltage: number) =>
      Math.max(...runMembrane([], 12, lifted(voltage)).states.map((state) => state.voltage));
    expect(peakOf(spike.thresholdVoltage + 0.5)).toBeGreaterThan(0);
    expect(peakOf(spike.thresholdVoltage - 0.5)).toBeLessThan(spike.thresholdVoltage + 0.5);
  });

  it('orders the points of the spike in time, each at the voltage its name says', () => {
    const order: SpikePhase[] = ['rest', 'threshold', 'rising', 'peak', 'falling', 'undershoot'];
    const indexes = order.map((phase) => spike.phaseIndex[phase]);
    indexes.slice(1).forEach((index, at) => expect(index).toBeGreaterThan(indexes[at] ?? 0));
    const volts = Object.fromEntries(order.map((phase) => [phase, spikePhysics(phase).voltage])) as Record<
      SpikePhase,
      number
    >;
    expect(volts.rest).toBeCloseTo(spike.restVoltage, 1);
    expect(volts.threshold).toBeGreaterThanOrEqual(spike.thresholdVoltage);
    expect(volts.rising).toBeGreaterThan(volts.threshold);
    expect(volts.rising).toBeLessThan(volts.peak);
    expect(volts.peak).toBe(spike.peakVoltage);
    expect(volts.falling).toBeLessThan(volts.peak);
    expect(volts.falling).toBeGreaterThan(volts.undershoot);
    expect(volts.undershoot).toBe(spike.undershootVoltage);
    expect(volts.undershoot).toBeLessThan(volts.rest);
  });
});

describe('the channels at each point of the spike against the textbook', () => {
  /** What every neuroscience text says of the two channels at each point of the spike. */
  const TEXTBOOK = {
    rest: ['ready', 'closed'],
    threshold: ['opening', 'closed'],
    rising: ['open', 'closed'],
    peak: ['shutting', 'open'],
    falling: ['shutting', 'open'],
    undershoot: ['inactive', 'closing'],
  } as const;

  it('has each channel in the state the textbook gives', () => {
    for (const phase of NERVE_ENUMS.phase) {
      const physics = spikePhysics(phase);
      expect([physics.sodium, physics.potassium], phase).toEqual(TEXTBOOK[phase]);
    }
  });

  it('opens the sodium channels before the potassium ones and shuts them first', () => {
    const { trace, phaseIndex } = actionPotential();
    const sodium = trace.states.map((state) => state.sodiumActivation ** 3 * state.sodiumAvailability);
    const potassium = trace.states.map((state) => state.potassiumActivation ** 4);
    const sodiumPeak = sodium.indexOf(Math.max(...sodium));
    const potassiumPeak = potassium.indexOf(Math.max(...potassium));
    expect(sodiumPeak).toBeLessThan(potassiumPeak);
    expect(sodiumPeak).toBeGreaterThanOrEqual(phaseIndex.rising);
    expect(sodiumPeak).toBeLessThanOrEqual(phaseIndex.falling);
  });

  it('cannot fire again right after a spike, however it is pushed, and can once it has recovered', () => {
    const { trace, phaseIndex } = actionPotential();
    expect(spikePhysics('rest').freshPushFires).toBe(true);
    expect(spikePhysics('threshold').freshPushFires).toBeNull();
    expect(spikePhysics('rising').freshPushFires).toBeNull();
    expect(spikePhysics('peak').freshPushFires).toBe(false);
    expect(spikePhysics('falling').freshPushFires).toBe(false);
    expect(spikePhysics('undershoot').freshPushFires).toBe(false);
    // Much later the membrane has recovered and the same push fires it again.
    expect(freshPushFiresAt(trace.states.length - 1)).toBe(true);
    expect(trace.states.length - 1).toBeGreaterThan(phaseIndex.undershoot);
    expect(channelsAtIndex(trace.states.length - 1).sodium).toBe('ready');
  });
});

describe('the pushes and the all-or-none rule', () => {
  const [weak, enough, strong] = pushResponses();

  it('lets a weak push die away, and gives a full spike for each of the two stronger', () => {
    expect(weak?.fires).toBe(false);
    expect(enough?.fires).toBe(true);
    expect(strong?.fires).toBe(true);
    const threshold = actionPotential().thresholdVoltage;
    expect(weak?.peakVoltage ?? 0).toBeLessThan(threshold);
    expect(weak?.thresholdTime).toBeNull();
  });

  it('gives the same spike for a push nearly three times as strong, within a few millivolts of the whole swing', () => {
    const swing = (enough?.peakVoltage ?? 0) - actionPotential().restVoltage;
    expect(Math.abs((strong?.peakVoltage ?? 0) - (enough?.peakVoltage ?? 0))).toBeLessThan(0.1 * swing);
  });

  it('gets the stronger push to the threshold sooner', () => {
    expect(strong?.thresholdTime ?? Infinity).toBeLessThan(enough?.thresholdTime ?? 0);
    expect(enough?.thresholdTime ?? 0).toBeGreaterThanOrEqual(PUSH_START);
  });

  it('agrees with a forward-Euler run for the weak push', () => {
    const euler = eulerSpike(actionPotential().pushCurrent.weak, 12);
    expect(Math.abs(Math.max(...euler) - (weak?.peakVoltage ?? 0))).toBeLessThan(0.5);
  });
});

describe('the spike along the axon', () => {
  const profile = axonProfile();
  const spike = actionPotential();

  it('is the spike’s own time course read backwards, so it keeps its height and its shape wherever it is', () => {
    expect(profile.voltage).toHaveLength(AXON_PROFILE_SAMPLES);
    expect(Math.max(...profile.voltage)).toBeCloseTo(spike.peakVoltage, 0);
    const peakAt = profile.voltage.indexOf(Math.max(...profile.voltage));
    expect(peakAt / (AXON_PROFILE_SAMPLES - 1)).toBeCloseTo(profile.peakShare, 1);
    // Behind the peak (the earlier samples) the voltage comes down through the undershoot; ahead of it is at rest.
    expect(Math.min(...profile.voltage.slice(0, peakAt))).toBeCloseTo(spike.undershootVoltage, 0);
    expect(profile.voltage[AXON_PROFILE_SAMPLES - 1] ?? 0).toBeLessThan(spike.thresholdVoltage);
    // The front is steeper than the back: the voltage rises faster ahead of the peak than it falls behind it.
    const front = Math.abs((profile.voltage[peakAt + 3] ?? 0) - (profile.voltage[peakAt] ?? 0));
    const back = Math.abs((profile.voltage[peakAt - 3] ?? 0) - (profile.voltage[peakAt] ?? 0));
    expect(front).toBeGreaterThan(back * 0.5);
  });

  it('is recovering behind the peak, where a fresh push does not fire it, and ready ahead of it', () => {
    const peakAt = Math.round(profile.peakShare * (AXON_PROFILE_SAMPLES - 1));
    expect(profile.recovering.slice(peakAt + 1).every((ready) => !ready)).toBe(true);
    // Just behind the peak the membrane is recovering.
    expect(profile.recovering.slice(0, peakAt).some(Boolean)).toBe(true);
    expect(profile.recovering[peakAt - 1]).toBe(true);
    // Far enough behind it has recovered.
    expect(profile.recovering[0]).toBe(false);
  });

  it('places the peak along the axon so that the whole stretch the spike covers lies on the axon, and in order', () => {
    const places = NERVE_ENUMS.along.map((place) => AXON_PEAK_AT[place]);
    places.slice(1).forEach((place, at) => expect(place).toBeGreaterThan(places[at] ?? 1));
    const width = 0.4;
    for (const place of places) {
      expect(place - profile.peakShare * width).toBeGreaterThanOrEqual(0);
      expect(place + (1 - profile.peakShare) * width).toBeLessThanOrEqual(1);
    }
  });
});

describe('the synapse', () => {
  const { restVoltage, thresholdVoltage } = actionPotential();

  it('moves the next cell’s voltage toward the threshold for an excitatory connection and away from it for an inhibitory one, from the ion that flows', () => {
    expect(synapticShift('excite', restVoltage)).toBeGreaterThan(0);
    expect(synapticShift('inhibit', restVoltage)).toBeLessThan(0);
    // The channel pulls the voltage toward the voltage at which its ions would stop.
    expect(synapticShift('excite', -30)).toBeGreaterThan(0);
    expect(synapticShift('inhibit', -30)).toBeLessThan(synapticShift('inhibit', restVoltage));
  });

  it('never lets one input fire the next cell alone', () => {
    const shifted = restVoltage + synapticShift('excite', restVoltage);
    expect(shifted).toBeGreaterThan(restVoltage);
    expect(shifted).toBeLessThan(thresholdVoltage);
  });

  it('changes nothing in the next cell before the receptors open, and fades after', () => {
    for (const effect of NERVE_ENUMS.effect) {
      for (const step of ['arrives', 'release', 'crossing'] as const)
        expect(synapsePhysics(step, effect).shift, `${step} ${effect}`).toBe(0);
      const bound = synapsePhysics('binding', effect).shift;
      const cleared = synapsePhysics('clearing', effect).shift;
      expect(Math.abs(cleared)).toBeLessThan(Math.abs(bound));
      expect(Math.sign(cleared)).toBe(Math.sign(bound));
    }
  });

  it('releases before the neurotransmitter crosses, has it in the gap until it binds, and opens the receptors only when it binds', () => {
    expect(synapsePhysics('arrives', 'excite')).toMatchObject({ released: false, inGap: false, receptorsOpen: false });
    expect(synapsePhysics('release', 'excite')).toMatchObject({ released: true, inGap: true, receptorsOpen: false });
    expect(synapsePhysics('crossing', 'excite')).toMatchObject({ released: true, inGap: true, receptorsOpen: false });
    expect(synapsePhysics('binding', 'excite')).toMatchObject({ released: true, inGap: true, receptorsOpen: true });
    expect(synapsePhysics('clearing', 'excite')).toMatchObject({ released: true, inGap: false, receptorsOpen: false });
  });
});

describe('the reflex arc', () => {
  it('runs sensor, sensory neuron, spinal cord, motor neuron, muscle, and tells the brain last, by the fewest links it must pass', () => {
    const links = NERVE_ENUMS.arcAt.map((step) => ARC_LINKS[step]);
    links.slice(1).forEach((count, at) => expect(count).toBeGreaterThan(links[at] ?? 0));
    expect(ARC_LINKS.brain).toBeGreaterThan(ARC_LINKS.muscle);
  });

  it('has the muscle respond while the news is still on its way to the brain', () => {
    expect(arcPhysics('muscle')).toMatchObject({ muscleResponding: true, newsOnItsWay: true, newsReachedBrain: false });
    expect(arcPhysics('sensory-neuron')).toMatchObject({ muscleResponding: false, newsOnItsWay: false });
    expect(arcPhysics('spinal-cord').newsOnItsWay).toBe(true);
    expect(arcPhysics('brain')).toMatchObject({ muscleResponding: true, newsOnItsWay: false, newsReachedBrain: true });
  });
});

describe('settling and describing a nerve state', () => {
  const states = NERVE_ENUMS.view.flatMap((view) =>
    NERVE_ENUMS.phase.flatMap((phase) =>
      NERVE_ENUMS.along.flatMap((along) =>
        NERVE_ENUMS.synapseAt.flatMap((synapseAt) =>
          NERVE_ENUMS.effect.flatMap((effect) =>
            NERVE_ENUMS.arcAt.flatMap((arcAt) =>
              NERVE_ENUMS.focus.map((focus): NerveState => ({ view, phase, along, synapseAt, effect, arcAt, focus })),
            ),
          ),
        ),
      ),
    ),
  );

  it('keeps only the keys a view uses, an effect only once the receptors have something to do, and a focus only for a part the view draws', () => {
    for (const state of states) {
      const settled = settleNerveState(state);
      if (state.view !== 'spike') expect(settled.phase).toBe('rest');
      if (state.view !== 'axon') expect(settled.along).toBe('start');
      if (state.view !== 'synapse') expect([settled.synapseAt, settled.effect]).toEqual(['arrives', 'excite']);
      if (state.view === 'synapse' && !['binding', 'clearing'].includes(state.synapseAt))
        expect(settled.effect).toBe('excite');
      if (state.view !== 'reflex') expect(settled.arcAt).toBe('sensor');
      if (settled.focus !== 'none') expect(nerveParts(settled.view)).toContain(settled.focus);
    }
  });

  it('says a fresh push does not fire the cell exactly where the physics says so', () => {
    for (const phase of NERVE_ENUMS.phase) {
      const text = describeNerveState({ ...INITIAL_NERVE_STATE, view: 'spike', phase, focus: 'none' });
      expect(text.includes('A fresh push that would normally make the cell fire does not.'), phase).toBe(
        spikePhysics(phase).freshPushFires === false,
      );
    }
    expect(spikePhysics('undershoot').freshPushFires).toBe(false);
    expect(spikePhysics('rest').freshPushFires).toBe(true);
  });

  it('says what the channels do from the physics, and a spike runs one way, keeps its size, and is not electricity down a wire', () => {
    const phases = NERVE_ENUMS.phase.map((phase) =>
      describeNerveState({ ...INITIAL_NERVE_STATE, view: 'spike', phase, focus: 'none' }),
    );
    expect(phases[2]).toContain('sodium ions rush in');
    expect(phases[3]).toContain('shutting themselves');
    expect(phases[4]).toContain('potassium ions flow out');
    expect(phases[5]).toContain('still recovering');
    const axon = describeNerveState({ ...INITIAL_NERVE_STATE, view: 'axon', along: 'middle', focus: 'none' });
    expect(axon).toContain('runs on in one direction');
    expect(axon).toContain('keeps its size');
    expect(axon).toContain('not electricity flowing down a wire');
  });

  it('says a connection excites or inhibits from the effect, and that this depends on the receptors', () => {
    const text = (effect: NerveState['effect']) =>
      describeNerveState({ ...INITIAL_NERVE_STATE, view: 'synapse', synapseAt: 'binding', effect, focus: 'none' });
    expect(text('excite')).toContain('toward the threshold');
    expect(text('excite')).toContain('excites the next cell');
    expect(text('inhibit')).toContain('away from the threshold');
    expect(text('inhibit')).toContain('inhibits the next cell');
    expect(text('inhibit')).toContain('depends on its receptors');
  });

  it('says the news is still on its way to the brain after the muscle responds, and no reflex is without a brain', () => {
    const text = (arcAt: NerveState['arcAt']) =>
      describeNerveState({ ...INITIAL_NERVE_STATE, view: 'reflex', arcAt, focus: 'none' });
    expect(text('muscle')).toContain('still on its way up to the brain');
    expect(text('brain')).toContain('after the muscle has already responded');
    expect(text('sensory-neuron')).not.toContain('still on its way');
  });

  it('gives no figure, no voltage, no named chemical and no disease', () => {
    for (const state of states) {
      const text = describeNerveState(state);
      expect(text, JSON.stringify(state)).not.toMatch(
        /\d|\bmV\b|millivolt|dopamine|serotonin|adrenaline|happiness|disease|drug/iu,
      );
    }
  });
});

describe('the traces keep their step', () => {
  it('is 0.01 ms, so a time and an index agree', () => {
    expect(TRACE_STEP).toBe(0.01);
    expect(timeOf(100)).toBe(1);
  });
});
