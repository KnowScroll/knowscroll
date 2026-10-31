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
  /** 1 while the sodium channels have just begun to open: drawn as a dashed arrow, since the true share is too small to see. */
  readonly sodiumOpening: number;
  /** 1 while sodium (or potassium) ions are flowing through open channels: drawn as a solid arrow. */
  readonly sodiumFlows: number;
  readonly potassiumFlows: number;
  /** 1 while a fresh push that would normally fire the cell would not: the cell is still recovering from its spike. */
  readonly pushWouldNotFire: number;
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

/** What a view that does not use a group of fields leaves them as: nothing drawn. */
const NO_VOLTAGES = { restVoltage: 0, thresholdVoltage: 0, peakVoltage: 0, undershootVoltage: 0 };
const NO_SPIKE = {
  curve: [] as readonly number[],
  markerTime: 0,
  sodiumOpen: 0,
  sodiumOpening: 0,
  sodiumFlows: 0,
  potassiumFlows: 0,
  potassiumOpen: 0,
  sodiumShut: 0,
  pushWouldNotFire: 0,
};
const NO_PUSHES = {
  weakCurve: [] as readonly number[],
  enoughCurve: [] as readonly number[],
  strongCurve: [] as readonly number[],
};
const NO_AXON = { profile: [] as readonly number[], recovering: [] as readonly number[], peakAt: 0, peakShare: 0 };
const NO_SYNAPSE = {
  released: 0,
  inGap: 0,
  gapProgress: 0,
  receptorsOpen: 0,
  shift: 0,
  synapseTime: 0,
  fullShift: 0,
  excites: 'excite' as NerveState['effect'],
};
const NO_ARC = { sensorLit: 0, sensoryLit: 0, cordLit: 0, motorLit: 0, muscleLit: 0, brainLit: 0, newsOnItsWay: 0 };

/** The voltage scale every view but the reflex draws against: the model's rest, threshold, peak and undershoot. */
function voltagesOf(): typeof NO_VOLTAGES {
  const { restVoltage, thresholdVoltage, peakVoltage, undershootVoltage } = actionPotential();
  return { restVoltage, thresholdVoltage, peakVoltage, undershootVoltage };
}

/**
 * The sodium channels' drawn opening when they have just begun to open. The model's share is a few thousandths
 * of its most, too little to see, so the picture draws the start as a dashed arrow and a slightly wider gap
 * (`sodiumOpening`) and keeps `sodiumOpen` honest.
 */
function spikeFields(phase: NerveState['phase']): typeof NO_SPIKE {
  const spike = actionPotential();
  const channels = spikePhysics(phase);
  return {
    curve: sampled(spike.trace.states.map((membrane) => membrane.voltage)),
    markerTime: channels.time,
    sodiumOpen: channels.sodiumOpenShare / spike.mostSodiumOpen,
    sodiumOpening: channels.sodium === 'opening' ? 1 : 0,
    sodiumFlows: channels.sodium === 'open' || channels.sodium === 'shutting' ? 1 : 0,
    potassiumFlows: channels.potassium === 'open' || channels.potassium === 'closing' ? 1 : 0,
    potassiumOpen: channels.potassiumOpenShare / spike.mostPotassiumOpen,
    sodiumShut: channels.sodium === 'shutting' || channels.sodium === 'inactive' ? 1 : 0,
    pushWouldNotFire: channels.freshPushFires === false ? 1 : 0,
  };
}

function pushFields(): typeof NO_PUSHES {
  const [weak, enough, strong] = pushResponses();
  return {
    weakCurve: sampled(weak?.voltage ?? []),
    enoughCurve: sampled(enough?.voltage ?? []),
    strongCurve: sampled(strong?.voltage ?? []),
  };
}

function axonFields(along: NerveState['along']): typeof NO_AXON {
  const profile = axonProfile();
  return {
    profile: profile.voltage,
    recovering: profile.recovering.map((recovering) => (recovering ? 1 : 0)),
    peakAt: AXON_PEAK_AT[along],
    peakShare: profile.peakShare,
  };
}

function synapseFields(step: NerveState['synapseAt'], effect: NerveState['effect']): typeof NO_SYNAPSE {
  const synapse = synapsePhysics(step, effect);
  return {
    released: synapse.released ? 1 : 0,
    inGap: synapse.inGap ? 1 : 0,
    gapProgress: GAP_PROGRESS[step],
    receptorsOpen: synapse.receptorsOpen ? 1 : 0,
    shift: synapse.shift,
    synapseTime: SYNAPSE_TIME_IN_CONSTANTS[step],
    fullShift: synapsePhysics('binding', effect).shift,
    excites: effect,
  };
}

function arcFields(step: NerveState['arcAt']): typeof NO_ARC {
  const arc = arcPhysics(step);
  const lit = (other: NerveState['arcAt']): number => (arcPhysics(other).links <= arc.links ? 1 : 0);
  return {
    sensorLit: lit('sensor'),
    sensoryLit: lit('sensory-neuron'),
    cordLit: lit('spinal-cord'),
    motorLit: lit('motor-neuron'),
    muscleLit: lit('muscle'),
    brainLit: arc.newsReachedBrain ? 1 : 0,
    newsOnItsWay: arc.newsOnItsWay ? 1 : 0,
  };
}

/**
 * The scene of a settled nerve state. Only the view's own fields are worked out: the membrane model costs a
 * little the first time (`actionPotential`, once) and the axon's recovering stretch a little more (`axonProfile`,
 * once), so a reflex never runs the model at all and a spike never runs the axon's probes.
 */
export function nerveSceneOf(state: NerveState): NerveScene {
  return {
    view: state.view,
    parts: nerveParts(state.view),
    focus: state.focus,
    ...(state.view === 'reflex' ? NO_VOLTAGES : voltagesOf()),
    ...(state.view === 'spike' ? spikeFields(state.phase) : NO_SPIKE),
    ...(state.view === 'all-or-none' ? pushFields() : NO_PUSHES),
    ...(state.view === 'axon' ? axonFields(state.along) : NO_AXON),
    ...(state.view === 'synapse' ? synapseFields(state.synapseAt, state.effect) : NO_SYNAPSE),
    ...(state.view === 'reflex' ? arcFields(state.arcAt) : NO_ARC),
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
