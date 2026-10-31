import {
  actionPotential,
  arcPhysics,
  AXON_PEAK_AT,
  axonProfile,
  nerveParts,
  postsynapticCourse,
  pushResponses,
  spikePhysics,
  SYNAPSE_TIME_IN_CONSTANTS,
  synapsePhysics,
  TRACE_STEP,
  type NerveState,
} from '../model';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the nerve kit (D-201): what the picture needs to place its parts, worked out from
 * the derived kit state and nothing else. The voltage of the spike, how open the channels are, whether a fresh
 * push would fire the cell, the recovering stretch behind a spike, the direction of a synaptic change and
 * which news reaches the brain after the muscle all come from `nerve.ts` and its model of the membrane; this
 * file only samples them and turns them into numbers the picture can draw and tween, so a picture cannot
 * disagree with the text version of the same state. No voltage is drawn as a figure.
 */

export type NerveView = NerveState['view'];

/** The traces are sampled every 0.1 ms of the model. */
const STATES_PER_SAMPLE = Math.round(0.1 / TRACE_STEP);
export const SAMPLE_MS = 0.1;

export interface NerveScene {
  readonly view: NerveView;
  readonly parts: readonly ReturnType<typeof nerveParts>[number][];
  readonly focus: NerveState['focus'];
  /** The voltage of the cell: the resting level, the threshold and the highest and lowest reached, for the vertical scale. */
  readonly restVoltage: number;
  readonly thresholdVoltage: number;
  readonly peakVoltage: number;
  readonly undershootVoltage: number;
  /** `spike`: the voltage over the spike, and the time of the marker. */
  readonly curve: readonly number[];
  readonly markerTime: number;
  /** How open the sodium and the potassium channels are against their most open in the spike (0 to 1), and 1 when the sodium channels have shut themselves. */
  readonly sodiumOpen: number;
  readonly potassiumOpen: number;
  readonly sodiumShut: number;
  /** `all-or-none`: the voltage over time for the weak, the enough and the strong push. */
  readonly weakCurve: readonly number[];
  readonly enoughCurve: readonly number[];
  readonly strongCurve: readonly number[];
  /** `axon`: the voltage along the stretch the spike covers, whether the membrane there is recovering (1) or ready (0), and where the peak sits along the axon and in the stretch. */
  readonly profile: readonly number[];
  readonly recovering: readonly number[];
  readonly peakAt: number;
  readonly peakShare: number;
  /** `synapse`: 1 once the packets have released, 1 while neurotransmitter is in the gap, how far across the gap it is, 1 while the receptors are open. */
  readonly released: number;
  readonly inGap: number;
  readonly gapProgress: number;
  readonly receptorsOpen: number;
  /** The next cell's voltage against rest now, and the time of the marker on its course in units of the constant. */
  readonly shift: number;
  readonly synapseTime: number;
  /** The change at the peak of its course, for the course drawn behind the marker, and whether it excites. */
  readonly fullShift: number;
  readonly excites: NerveState['effect'];
  /** `reflex`: 1 for a part the signal has reached, 1 while news is on its way up, 1 while the muscle has responded. */
  readonly sensorLit: number;
  readonly sensoryLit: number;
  readonly cordLit: number;
  readonly motorLit: number;
  readonly muscleLit: number;
  readonly brainLit: number;
  readonly newsOnItsWay: number;
}

function sampled(voltage: readonly number[]): number[] {
  return voltage.filter((_, index) => index % STATES_PER_SAMPLE === 0);
}

/** How far across the gap the neurotransmitter has got at each step of the synapse (a drawing parameter: the position is not physics). */
const GAP_PROGRESS: Readonly<Record<NerveState['synapseAt'], number>> = {
  arrives: 0,
  release: 0.12,
  crossing: 0.55,
  binding: 1,
  clearing: 0.5,
};

/** The scene of a settled nerve state. */
export function nerveSceneOf(state: NerveState): NerveScene {
  const spike = actionPotential();
  const channels = spikePhysics(state.phase);
  const [weak, enough, strong] = pushResponses();
  const profile = axonProfile();
  const synapse = synapsePhysics(state.synapseAt, state.effect);
  const arc = arcPhysics(state.arcAt);
  const fullShift = synapsePhysics('binding', state.effect).shift;
  const lit = (step: NerveState['arcAt']): number => (arcPhysics(step).links <= arc.links ? 1 : 0);
  return {
    view: state.view,
    parts: nerveParts(state.view),
    focus: state.focus,
    restVoltage: spike.restVoltage,
    thresholdVoltage: spike.thresholdVoltage,
    peakVoltage: spike.peakVoltage,
    undershootVoltage: spike.undershootVoltage,
    curve: sampled(spike.trace.states.map((membrane) => membrane.voltage)),
    markerTime: channels.time,
    sodiumOpen: channels.sodiumOpenShare / spike.mostSodiumOpen,
    potassiumOpen: channels.potassiumOpenShare / spike.mostPotassiumOpen,
    sodiumShut: channels.sodium === 'shutting' || channels.sodium === 'inactive' ? 1 : 0,
    weakCurve: sampled(weak?.voltage ?? []),
    enoughCurve: sampled(enough?.voltage ?? []),
    strongCurve: sampled(strong?.voltage ?? []),
    profile: profile.voltage,
    recovering: profile.recovering.map((recovering) => (recovering ? 1 : 0)),
    peakAt: AXON_PEAK_AT[state.along],
    peakShare: profile.peakShare,
    released: synapse.released ? 1 : 0,
    inGap: synapse.inGap ? 1 : 0,
    gapProgress: GAP_PROGRESS[state.synapseAt],
    receptorsOpen: synapse.receptorsOpen ? 1 : 0,
    shift: synapse.shift,
    synapseTime: SYNAPSE_TIME_IN_CONSTANTS[state.synapseAt],
    fullShift,
    excites: state.effect,
    sensorLit: lit('sensor'),
    sensoryLit: lit('sensory-neuron'),
    cordLit: lit('spinal-cord'),
    motorLit: lit('motor-neuron'),
    muscleLit: lit('muscle'),
    brainLit: arc.newsReachedBrain ? 1 : 0,
    newsOnItsWay: arc.newsOnItsWay ? 1 : 0,
  };
}

/** The course of the next cell's voltage at a time in units of its constant, against its change at the peak. */
export const courseAt = postsynapticCourse;

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenNerve(from: NerveScene, to: NerveScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpNerveScene(from: NerveScene, to: NerveScene, progress: number): NerveScene {
  return blendScenes(from, to, progress);
}
