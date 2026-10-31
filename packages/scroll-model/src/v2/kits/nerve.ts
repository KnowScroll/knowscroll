import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';
import {
  hasSpikeAfter,
  membraneAtRest,
  potassiumOpenShare,
  runMembrane,
  sodiumOpenShare,
  TRACE_STEP,
  timeOf,
  type MembraneState,
  type MembraneTrace,
} from './membrane.js';

/**
 * The nerve kit (D-201): the voltage across a nerve cell's membrane through a spike, the all-or-none rule, the
 * spike running along an axon, a synapse, and a reflex arc. The writer chooses the view, the point of the spike,
 * where it is along the axon, the step of the synapse, whether the connection excites or inhibits, the step of
 * the reflex and the part to look at. Code derives the rest (D-202): the voltage and the channels' state at each
 * point of the spike from a model of the membrane (Hodgkin-Huxley), the threshold, whether a push fires the cell,
 * the recovering stretch behind a spike, the direction of a synaptic change from the ion that flows, and which
 * news reaches the brain after the muscle. A stored state has no field in which a spike could be bigger for a
 * stronger push or run both ways.
 *
 * No voltage, speed or time is ever shown as a figure. The picture is simple and not to scale.
 */
export const NERVE_KIT = 'nerve.v1';

export const NERVE_ENUMS = {
  /**
   * What the picture is of. `spike` is one action potential as a graph, with the channels; `all-or-none` is
   * three pushes of different strength; `axon` is the spike running along an axon; `synapse` is the gap
   * between two cells; `reflex` is the loop through the spinal cord.
   */
  view: ['spike', 'all-or-none', 'axon', 'synapse', 'reflex'],
  /** In `spike`: the point of the spike, in order. */
  phase: ['rest', 'threshold', 'rising', 'peak', 'falling', 'undershoot'],
  /** In `axon`: where the spike has got to, away from the cell body. */
  along: ['start', 'early', 'middle', 'end'],
  /** In `synapse`: the step of the signal crossing, in order. */
  synapseAt: ['arrives', 'release', 'crossing', 'binding', 'clearing'],
  /** In `synapse`, from `binding` on: whether the receptors the neurotransmitter meets excite or inhibit the next cell. */
  effect: ['excite', 'inhibit'],
  /** In `reflex`: where the signal has got to, in order. The brain is last. */
  arcAt: ['sensor', 'sensory-neuron', 'spinal-cord', 'motor-neuron', 'muscle', 'brain'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: [
    'none',
    'trace',
    'threshold',
    'channels',
    'weak-push',
    'strong-push',
    'spike',
    'recovering',
    'vesicles',
    'gap',
    'receptors',
    'sensor',
    'sensory-neuron',
    'spinal-cord',
    'motor-neuron',
    'muscle',
    'brain',
  ],
} as const;

export type NerveState = KitState<typeof NERVE_ENUMS>;
export type NervePatch = KitPatch<typeof NERVE_ENUMS>;
export type NerveView = NerveState['view'];
export type SpikePhase = NerveState['phase'];
export type AxonPlace = NerveState['along'];
export type SynapseStep = NerveState['synapseAt'];
export type SynapseEffect = NerveState['effect'];
export type ArcStep = NerveState['arcAt'];

export const INITIAL_NERVE_STATE: NerveState = {
  view: 'spike',
  phase: 'rest',
  along: 'start',
  synapseAt: 'arrives',
  effect: 'excite',
  arcAt: 'sensor',
  focus: 'none',
};

export const NerveStateSchema = kitStateSchema(NERVE_ENUMS);

/** The parts of the kit a picture may be made of. A focus names one of them. */
export type NervePart = Exclude<NerveState['focus'], 'none'>;

/** What a view draws. A focus on anything else is set aside. */
export function nerveParts(view: NerveView): readonly NervePart[] {
  switch (view) {
    case 'spike':
      return ['trace', 'threshold', 'channels'];
    case 'all-or-none':
      return ['threshold', 'weak-push', 'strong-push'];
    case 'axon':
      return ['spike', 'recovering'];
    case 'synapse':
      return ['vesicles', 'gap', 'receptors'];
    case 'reflex':
      return ['sensor', 'sensory-neuron', 'spinal-cord', 'motor-neuron', 'muscle', 'brain'];
  }
}

/** The values a picture shows when a key does not matter to the view, so unseen differences are not counted as change. */
const NEUTRAL = {
  phase: 'rest',
  along: 'start',
  synapseAt: 'arrives',
  effect: 'excite',
  arcAt: 'sensor',
} as const;

/** The step from which a synapse has an effect to draw: before the neurotransmitter binds, the next cell does not change. */
const EFFECT_STEPS: readonly SynapseStep[] = ['binding', 'clearing'];

/** The state a view can really show: a key the view does not use is set aside, and so is a focus on a part that is not drawn. Idempotent. */
export function settleNerveState(state: NerveState): NerveState {
  const parts = nerveParts(state.view);
  const synapse = state.view === 'synapse';
  return {
    view: state.view,
    phase: state.view === 'spike' ? state.phase : NEUTRAL.phase,
    along: state.view === 'axon' ? state.along : NEUTRAL.along,
    synapseAt: synapse ? state.synapseAt : NEUTRAL.synapseAt,
    effect: synapse && EFFECT_STEPS.includes(state.synapseAt) ? state.effect : NEUTRAL.effect,
    arcAt: state.view === 'reflex' ? state.arcAt : NEUTRAL.arcAt,
    focus: state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The spike, from the model of the membrane.

/** The push is a square pulse of current into the cell. */
export const PUSH_START = 1;
export const PUSH_END = 2;

/** A push's strength against the weakest that fires the cell. */
export const PUSH_STRENGTH = { weak: 0.5, enough: 1.5, strong: 4 } as const;
export type PushSize = keyof typeof PUSH_STRENGTH;

/** How long the traces run, in milliseconds of the model. */
export const SPIKE_DURATION_MS = 16;
export const PUSH_RESPONSE_DURATION_MS = 12;

export interface ActionPotential {
  readonly trace: MembraneTrace;
  readonly weakestFiringCurrent: number;
  readonly pushCurrent: Readonly<Record<PushSize, number>>;
  /** The voltage past which the cell fires by itself: the lowest a sudden lift from rest can be and still make a spike. */
  readonly thresholdVoltage: number;
  readonly restVoltage: number;
  readonly peakVoltage: number;
  readonly undershootVoltage: number;
  /** The largest share of the sodium and of the potassium channels open at any moment of the spike: what the picture draws against. */
  readonly mostSodiumOpen: number;
  readonly mostPotassiumOpen: number;
  /** The index in the trace of each point of the spike. */
  readonly phaseIndex: Readonly<Record<SpikePhase, number>>;
}

const voltageOf = (trace: MembraneTrace, index: number): number => trace.states[index]?.voltage ?? 0;

function peakOf(trace: MembraneTrace): { index: number; voltage: number } {
  let index = 0;
  trace.states.forEach((state, at) => {
    if (state.voltage > voltageOf(trace, index)) index = at;
  });
  return { index, voltage: voltageOf(trace, index) };
}

/** Bisects between a value that does not fire and one that does, to a very fine gap. */
function weakestThatFires(fires: (value: number) => boolean, low: number, high: number): number {
  let [doesNot, does] = [low, high];
  for (let round = 0; round < 40; round += 1) {
    const middle = (doesNot + does) / 2;
    if (fires(middle)) does = middle;
    else doesNot = middle;
  }
  return does;
}

const pushOf = (current: number) => [{ start: PUSH_START, end: PUSH_END, current }] as const;

function firstIndexAtOrAbove(trace: MembraneTrace, from: number, voltage: number): number {
  const found = trace.states.findIndex((state, index) => index >= from && state.voltage >= voltage);
  return found < 0 ? from : found;
}

function computeActionPotential(): ActionPotential {
  const rest = membraneAtRest();
  const weakestFiringCurrent = weakestThatFires(
    (current) => peakOf(runMembrane(pushOf(current), 8)).voltage > 0,
    0,
    100,
  );
  const pushCurrent = {
    weak: weakestFiringCurrent * PUSH_STRENGTH.weak,
    enough: weakestFiringCurrent * PUSH_STRENGTH.enough,
    strong: weakestFiringCurrent * PUSH_STRENGTH.strong,
  };
  const thresholdVoltage = weakestThatFires(
    (voltage) => peakOf(runMembrane([], 8, { ...rest, voltage })).voltage > 0,
    rest.voltage,
    -30,
  );
  const trace = runMembrane(pushOf(pushCurrent.enough), SPIKE_DURATION_MS);
  const peak = peakOf(trace);
  const pushStartIndex = Math.round(PUSH_START / TRACE_STEP);
  const threshold = firstIndexAtOrAbove(trace, pushStartIndex, thresholdVoltage);
  const rising = firstIndexAtOrAbove(trace, threshold, (thresholdVoltage + peak.voltage) / 2);
  let falling = peak.index;
  while (voltageOf(trace, falling) > (peak.voltage + rest.voltage) / 2) falling += 1;
  let undershoot = peak.index;
  for (let index = peak.index; index < trace.states.length; index += 1)
    if (voltageOf(trace, index) < voltageOf(trace, undershoot)) undershoot = index;
  return {
    trace,
    weakestFiringCurrent,
    pushCurrent,
    thresholdVoltage,
    restVoltage: rest.voltage,
    peakVoltage: peak.voltage,
    undershootVoltage: voltageOf(trace, undershoot),
    mostSodiumOpen: Math.max(...trace.states.map(sodiumOpenShare)),
    mostPotassiumOpen: Math.max(...trace.states.map(potassiumOpenShare)),
    phaseIndex: {
      rest: Math.round(0.5 / TRACE_STEP),
      threshold,
      rising,
      peak: peak.index,
      falling,
      undershoot,
    },
  };
}

let actionPotentialCache: ActionPotential | undefined;

/** The spike the picture shows, worked out once from the model of the membrane. */
export function actionPotential(): ActionPotential {
  actionPotentialCache ??= computeActionPotential();
  return actionPotentialCache;
}

/** How a sodium channel is: shut but ready, starting to open, open, shutting itself (inactivating), or shut and recovering. */
export type SodiumChannels = 'ready' | 'opening' | 'open' | 'shutting' | 'inactive';
/** How a potassium channel is: shut, open, or open but slowly closing. */
export type PotassiumChannels = 'closed' | 'open' | 'closing';

export interface ChannelsPhysics {
  readonly sodium: SodiumChannels;
  readonly potassium: PotassiumChannels;
  readonly sodiumOpenShare: number;
  readonly potassiumOpenShare: number;
  /** Whether a push that would normally fire the cell fires it now, or `null` while the spike itself is still rising. */
  readonly freshPushFires: boolean | null;
}

const SODIUM_BARELY_OPEN = 0.01;
const SODIUM_AVAILABLE = 0.35;
const POTASSIUM_OPEN = 0.05;

function slopeAt(trace: MembraneTrace, index: number, quantity: (state: MembraneState) => number): number {
  const before = trace.states[Math.max(0, index - 1)];
  const after = trace.states[Math.min(trace.states.length - 1, index + 1)];
  if (before === undefined || after === undefined) return 0;
  return (quantity(after) - quantity(before)) / (2 * TRACE_STEP);
}

/** Whether a fresh strong push, given at this index of the spike's trace, makes the cell fire a second time. */
export function freshPushFiresAt(index: number): boolean {
  const { trace, pushCurrent } = actionPotential();
  const state = trace.states[index];
  if (state === undefined) return false;
  const start = timeOf(index);
  return hasSpikeAfter(runMembrane([{ start, end: start + 1, current: pushCurrent.strong }], 8, state, start));
}

/** The channels at an index of the spike's trace: derived from the model's gates, never written by the model. */
export function channelsAtIndex(index: number): ChannelsPhysics {
  const { trace, phaseIndex } = actionPotential();
  const state = trace.states[index] ?? membraneAtRest();
  const sodiumShare = sodiumOpenShare(state);
  const potassiumShare = potassiumOpenShare(state);
  const sodiumSlope = slopeAt(trace, index, sodiumOpenShare);
  const potassiumSlope = slopeAt(trace, index, potassiumOpenShare);
  const available = state.sodiumAvailability >= SODIUM_AVAILABLE;
  const sodium: SodiumChannels =
    sodiumShare < SODIUM_BARELY_OPEN
      ? !available
        ? 'inactive'
        : sodiumSlope > 0.0003
          ? 'opening'
          : 'ready'
      : available
        ? 'open'
        : 'shutting';
  const potassium: PotassiumChannels =
    potassiumShare < POTASSIUM_OPEN ? 'closed' : potassiumSlope >= 0 ? 'open' : 'closing';
  const spikeUnderway = index >= phaseIndex.threshold && index < phaseIndex.peak;
  return {
    sodium,
    potassium,
    sodiumOpenShare: sodiumShare,
    potassiumOpenShare: potassiumShare,
    freshPushFires: spikeUnderway ? null : freshPushFiresAt(index),
  };
}

export interface SpikePhysics extends ChannelsPhysics {
  readonly index: number;
  readonly time: number;
  readonly voltage: number;
}

const spikePhysicsCache = new Map<SpikePhase, SpikePhysics>();

/** What follows from a point of the spike by physics. Worked out once for each point. */
export function spikePhysics(phase: SpikePhase): SpikePhysics {
  const known = spikePhysicsCache.get(phase);
  if (known !== undefined) return known;
  const index = actionPotential().phaseIndex[phase];
  const physics = {
    ...channelsAtIndex(index),
    index,
    time: timeOf(index),
    voltage: voltageOf(actionPotential().trace, index),
  };
  spikePhysicsCache.set(phase, physics);
  return physics;
}

// ---------------------------------------------------------------------------------------------------------------
// The all-or-none rule: three pushes.

export interface PushResponse {
  readonly size: PushSize;
  readonly voltage: readonly number[];
  readonly peakVoltage: number;
  readonly fires: boolean;
  /** The time the voltage first reaches the threshold, or `null` if it never does. */
  readonly thresholdTime: number | null;
}

let pushResponsesCache: readonly PushResponse[] | undefined;

/** The response of the cell to a weak, an enough and a strong push, worked out from the model of the membrane. */
export function pushResponses(): readonly PushResponse[] {
  pushResponsesCache ??= (['weak', 'enough', 'strong'] as const).map((size): PushResponse => {
    const { pushCurrent, thresholdVoltage } = actionPotential();
    const trace = runMembrane(pushOf(pushCurrent[size]), PUSH_RESPONSE_DURATION_MS);
    const peak = peakOf(trace);
    const crossing = trace.states.findIndex((state) => state.voltage >= thresholdVoltage);
    return {
      size,
      voltage: trace.states.map((state) => state.voltage),
      peakVoltage: peak.voltage,
      fires: peak.voltage > 0,
      thresholdTime: crossing < 0 ? null : timeOf(crossing),
    };
  });
  return pushResponsesCache;
}

// ---------------------------------------------------------------------------------------------------------------
// The spike running along an axon.

/** Where the spike's peak is along the axon, as a share of its length from the cell body, at each place. */
export const AXON_PEAK_AT: Readonly<Record<AxonPlace, number>> = { start: 0.4, early: 0.55, middle: 0.7, end: 0.88 };

/** How much of the spike's time course the axon shows, either side of its peak, in milliseconds of the model. */
const LEAD_MS = 1.9;
const TAIL_MS = 8.5;
export const AXON_PROFILE_SAMPLES = 61;

export interface AxonProfile {
  /** The voltage along the stretch of axon the spike covers, from the cell body's side (behind the peak) to the far side (ahead of it). */
  readonly voltage: readonly number[];
  /** Whether a fresh strong push would fire the membrane there: false behind the peak while it is recovering and cannot fire again. */
  readonly recovering: readonly boolean[];
  /** Where the peak sits in the profile, as a share of its width from the cell-body side. */
  readonly peakShare: number;
}

let axonProfileCache: AxonProfile | undefined;

/**
 * The spike along the axon at one instant. A spike keeps its shape as it travels, so the voltage along the axon
 * is the voltage at one point over time, read backwards: what has passed is behind the peak and what has yet to
 * come is ahead of it. The membrane behind the peak is checked for whether a fresh push would fire it.
 */
export function axonProfile(): AxonProfile {
  if (axonProfileCache === undefined) {
    const { trace, phaseIndex } = actionPotential();
    const peakTime = timeOf(phaseIndex.peak);
    const indexes = Array.from({ length: AXON_PROFILE_SAMPLES }, (_, sample) => {
      const time = peakTime + TAIL_MS - (sample * (LEAD_MS + TAIL_MS)) / (AXON_PROFILE_SAMPLES - 1);
      return Math.min(trace.states.length - 1, Math.max(0, Math.round(time / TRACE_STEP)));
    });
    axonProfileCache = {
      voltage: indexes.map((index) => voltageOf(trace, index)),
      recovering: indexes.map((index) => index > phaseIndex.peak && !freshPushFiresAt(index)),
      peakShare: TAIL_MS / (LEAD_MS + TAIL_MS),
    };
  }
  return axonProfileCache;
}

// ---------------------------------------------------------------------------------------------------------------
// The synapse.

/** Where the next cell sits at rest, and the voltage at which each kind of channel would stop its ions: the membrane model's values for the excitatory channel (open to sodium and potassium, 0 mV) and a potassium channel. */
export const EXCITATORY_REVERSAL = 0;
export const INHIBITORY_REVERSAL = -90;
/** How far the opened receptor channels pull the voltage towards their reversal voltage. Illustrative, and small: one input alone does not fire the cell. */
export const SYNAPTIC_PULL = 0.05;

/** The change in the next cell's voltage while the receptors are open: the pull towards the voltage at which the ions that flow would stop. */
export function synapticShift(effect: SynapseEffect, restVoltage: number): number {
  const reversal = effect === 'excite' ? EXCITATORY_REVERSAL : INHIBITORY_REVERSAL;
  return SYNAPTIC_PULL * (reversal - restVoltage);
}

export interface SynapsePhysics {
  /** The packets have joined the sending cell's membrane and let go of their neurotransmitter. */
  readonly released: boolean;
  /** Neurotransmitter is in the gap. */
  readonly inGap: boolean;
  /** The receptors have bound neurotransmitter and their channels are open. */
  readonly receptorsOpen: boolean;
  /** The change in the next cell's voltage now, against rest: 0 until the receptors open, then the full change at its peak and a fraction of it as it fades. */
  readonly shift: number;
  readonly restVoltage: number;
  readonly thresholdVoltage: number;
}

/**
 * The rise and fall of the next cell's voltage once the receptors open, against time in units of its time
 * constant: it peaks at 1 and fades afterwards (an alpha function, the textbook shape of a synaptic potential).
 */
export function postsynapticCourse(timeInConstants: number): number {
  return timeInConstants <= 0 ? 0 : timeInConstants * Math.exp(1 - timeInConstants);
}

/** Where on that course each step of the synapse sits: nothing has changed until the receptors open, the peak is at binding, and clearing is later on the fall. */
export const SYNAPSE_TIME_IN_CONSTANTS: Readonly<Record<SynapseStep, number>> = {
  arrives: 0,
  release: 0,
  crossing: 0,
  binding: 1,
  clearing: 3,
};

/** What follows from a step of the synapse and the kind of connection by physics. */
export function synapsePhysics(step: SynapseStep, effect: SynapseEffect): SynapsePhysics {
  const { restVoltage, thresholdVoltage } = actionPotential();
  return {
    released: step !== 'arrives',
    inGap: step === 'release' || step === 'crossing' || step === 'binding',
    receptorsOpen: step === 'binding',
    shift: postsynapticCourse(SYNAPSE_TIME_IN_CONSTANTS[step]) * synapticShift(effect, restVoltage) + 0,
    restVoltage,
    thresholdVoltage,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The reflex arc.

/**
 * How many stretches of nerve fibre and synapses the signal has passed at each step, at the fewest. The reflex
 * runs sensory neuron, a synapse in the cord, motor neuron, the junction with the muscle. The news to the brain
 * passes the same synapse in the cord and then a longer climb and at least two more relays. Only the order is the
 * physiology; the numbers are counts of links, never times.
 */
export const ARC_LINKS: Readonly<Record<ArcStep, number>> = {
  sensor: 0,
  'sensory-neuron': 1,
  'spinal-cord': 2,
  'motor-neuron': 3,
  muscle: 4,
  brain: 6,
};

export interface ArcPhysics {
  readonly links: number;
  /** The muscle has been told by now. */
  readonly muscleResponding: boolean;
  /** News of it is on its way up to the brain and has not got there. */
  readonly newsOnItsWay: boolean;
  readonly newsReachedBrain: boolean;
}

/** What follows from a step of the reflex by physics. */
export function arcPhysics(step: ArcStep): ArcPhysics {
  const links = ARC_LINKS[step];
  return {
    links,
    muscleResponding: links >= ARC_LINKS.muscle,
    newsOnItsWay: links >= ARC_LINKS['spinal-cord'] && links < ARC_LINKS.brain,
    newsReachedBrain: links >= ARC_LINKS.brain,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The text version of each state.

const FOCUS_SENTENCE: Readonly<Record<NerveState['focus'], string>> = {
  none: '',
  trace: 'The picture draws the eye to the voltage graph.',
  threshold: 'The picture draws the eye to the threshold.',
  channels: 'The picture draws the eye to the channels.',
  'weak-push': 'The picture draws the eye to the weak push.',
  'strong-push': 'The picture draws the eye to the strong push.',
  spike: 'The picture draws the eye to the spike.',
  recovering: 'The picture draws the eye to the recovering stretch.',
  vesicles: 'The picture draws the eye to the packets.',
  gap: 'The picture draws the eye to the gap.',
  receptors: 'The picture draws the eye to the receptors.',
  sensor: 'The picture draws the eye to the sensor.',
  'sensory-neuron': 'The picture draws the eye to the sensory neuron.',
  'spinal-cord': 'The picture draws the eye to the spinal cord.',
  'motor-neuron': 'The picture draws the eye to the motor neuron.',
  muscle: 'The picture draws the eye to the muscle.',
  brain: 'The picture draws the eye to the brain.',
};

const SODIUM_WORDS: Readonly<Record<SodiumChannels, string>> = {
  ready: 'The sodium channels are shut but ready',
  opening: 'The sodium channels begin to open',
  open: 'Sodium channels are open and sodium ions rush in',
  shutting: 'The sodium channels are shutting themselves',
  inactive: 'The sodium channels are still recovering',
};

const POTASSIUM_WORDS: Readonly<Record<PotassiumChannels, string>> = {
  closed: 'the potassium channels are mostly shut',
  open: 'potassium channels are open and potassium ions flow out',
  closing: 'the potassium channels are slow to close',
};

function spikeSentences(phase: SpikePhase): string[] {
  const physics = spikePhysics(phase);
  const voltage: Readonly<Record<SpikePhase, string>> = {
    rest: 'At rest the inside of the cell is negative.',
    threshold: 'A push has lifted the voltage to the threshold, the point beyond which the cell fires by itself.',
    rising: 'The voltage shoots up toward positive.',
    peak: 'At the top the inside of the cell is positive, and sodium coming in balances potassium going out.',
    falling: 'The voltage falls back.',
    undershoot: 'The voltage dips below rest.',
  };
  const refractory =
    physics.freshPushFires === false ? 'A fresh push that would normally make the cell fire does not.' : '';
  return [
    'The voltage across a nerve cell’s membrane during one spike, as a graph with the resting level, the threshold and zero marked, and a marker for now. Beneath it, a sketch of the two kinds of channel in the membrane.',
    voltage[phase],
    `${SODIUM_WORDS[physics.sodium]}, and ${POTASSIUM_WORDS[physics.potassium]}.`,
    refractory,
  ];
}

function allOrNoneSentences(): string[] {
  return [
    'Three pushes of different strength, each as a graph of the cell’s voltage with the threshold marked. The weak push lifts the voltage but not to the threshold, and it dies away. The two stronger pushes each give a full spike of about the same height, and the strongest reaches the threshold sooner. A spike is all or nothing: a stronger push does not make a bigger one.',
  ];
}

const ALONG_WORDS: Readonly<Record<AxonPlace, string>> = {
  start: 'The spike has just left the cell body.',
  early: 'The spike is on its way along the axon.',
  middle: 'The spike is halfway along the axon.',
  end: 'The spike is nearing the far end of the axon.',
};

function axonSentences(place: AxonPlace): string[] {
  return [
    'A spike running along a nerve cell’s axon, away from the cell body, drawn as the voltage along the axon at one instant. Ahead of the spike the membrane is at rest and ready. Behind it the membrane is recovering and cannot fire again yet, so the signal runs on in one direction. The spike keeps its size as it goes. It is a wave of voltage change across the membrane, not electricity flowing down a wire. The spike’s length against the axon is not to scale.',
    ALONG_WORDS[place],
  ];
}

function synapseSentences(step: SynapseStep, effect: SynapseEffect): string[] {
  const physics = synapsePhysics(step, effect);
  const binding =
    effect === 'excite'
      ? 'Ions flow through them that make the inside less negative, so the voltage moves toward the threshold. The size of the change is illustrative: a cell adds up many inputs to decide whether to fire.'
      : 'Ions flow through them that make the inside more negative, so the voltage moves away from the threshold. The size of the change is illustrative: a cell adds up many inputs to decide whether to fire.';
  const steps: Readonly<Record<SynapseStep, string>> = {
    arrives: 'A spike reaches the end of the sending cell. Packets of neurotransmitter wait there.',
    release: 'The packets join the membrane and release their neurotransmitter into the gap.',
    crossing: 'The neurotransmitter spreads across the gap.',
    binding: `It binds receptors on the next cell and opens their channels. ${binding}`,
    clearing:
      'The neurotransmitter is cleared away, the receptors’ channels close, and the next cell’s voltage settles back toward rest.',
  };
  return [
    'The end of one nerve cell, the gap beside it and the next cell, drawn simply, with a small graph of the next cell’s voltage against its threshold.',
    steps[step],
    physics.receptorsOpen || step === 'clearing'
      ? `This connection ${effect === 'excite' ? 'excites' : 'inhibits'} the next cell, which depends on its receptors, not on the neurotransmitter alone.`
      : '',
  ];
}

function reflexSentences(step: ArcStep): string[] {
  const physics = arcPhysics(step);
  const steps: Readonly<Record<ArcStep, string>> = {
    sensor: 'A stimulus stirs the sensor and starts a signal.',
    'sensory-neuron': 'The signal runs along the sensory neuron toward the spinal cord.',
    'spinal-cord':
      'In the spinal cord the signal passes on to a motor neuron without waiting for the brain, and news of it also starts up toward the brain.',
    'motor-neuron': 'The signal runs out along the motor neuron toward the muscle.',
    muscle: 'The muscle responds.',
    brain: 'The news reaches the brain, after the muscle has already responded.',
  };
  return [
    'A simple plan of a reflex: a sensor, a sensory neuron into the spinal cord, a motor neuron out to a muscle, and a branch up to the brain.',
    steps[step],
    physics.newsOnItsWay && step !== 'spinal-cord' ? 'News of it is still on its way up to the brain.' : '',
  ];
}

/**
 * What a nerve state shows, as sentences: the text version of a stage and its accessible name. It is derived by
 * code from the state and its physics, never written by the model, and it settles the state first, so it
 * mentions only what the view draws and cannot disagree with the picture. It gives no figure.
 */
export function describeNerveState(chosen: NerveState): string {
  const state = settleNerveState(chosen);
  const sentences =
    state.view === 'spike'
      ? spikeSentences(state.phase)
      : state.view === 'all-or-none'
        ? allOrNoneSentences()
        : state.view === 'axon'
          ? axonSentences(state.along)
          : state.view === 'synapse'
            ? synapseSentences(state.synapseAt, state.effect)
            : reflexSentences(state.arcAt);
  return [...sentences, FOCUS_SENTENCE[state.focus]].filter((sentence) => sentence !== '').join(' ');
}

export const NERVE_KIT_DEFINITION = defineKit({
  id: NERVE_KIT,
  enums: NERVE_ENUMS,
  initial: INITIAL_NERVE_STATE,
  settle: settleNerveState,
  describe: describeNerveState,
  writerGuide: [
    'Code draws the picture from a fixed kit: the voltage across a nerve cell’s membrane through one spike with its channels, three pushes of different strength, a spike running along an axon, a synapse, and a reflex arc. You choose only the view, the point of the spike, where it is along the axon, the step of the synapse, whether the connection excites or inhibits, the step of the reflex and the part to look at, from the listed words. Code decides everything else: the voltage and the state of the channels at each point of the spike, the threshold, whether a push fires the cell, which stretch is recovering and the direction of the change at a synapse. So the words you choose are claims the picture makes: choose the ones that match what the stop says.',
    '- The views: "spike" shows one action potential as a graph; "phase" is, in order, "rest", "threshold" (the push has lifted the voltage to the point beyond which the cell fires by itself), "rising" (sodium channels open and sodium ions rush in), "peak", "falling" (potassium ions flow out) and "undershoot" (the voltage dips below rest and the cell cannot fire again for a moment). "all-or-none" shows a weak push that dies away and two stronger pushes that give spikes of the same size. "axon" shows the spike at one instant along the axon, running away from the cell body, with the stretch behind it recovering; "along" is "start", "early", "middle" or "end". "synapse" shows the end of one cell, the gap and the next cell; "synapseAt" is, in order, "arrives", "release", "crossing", "binding" and "clearing", and "effect" is "excite" or "inhibit" (it matters from "binding" on). "reflex" shows a sensor, a sensory neuron, the spinal cord, a motor neuron, a muscle and a branch to the brain; "arcAt" is, in order, "sensor", "sensory-neuron", "spinal-cord", "motor-neuron", "muscle" and "brain". A key a view does not use is ignored.',
    '- The picture draws no voltage figure, speed or time, no named chemical and no disease, so say nothing that depends on one: the shapes are from a standard model of the membrane and a human cell differs in its numbers. A spike is all or nothing, so never say a stronger push makes a bigger spike. A nerve is not a wire carrying electricity, so never say that it is. Whether a synapse excites or inhibits depends on the receptor, not on the neurotransmitter alone, so never call one chemical a "happiness chemical". A reflex still uses the spinal cord and the brain is told a moment later, so never say a reflex involves no brain at all or is a decision.',
  ],
});
