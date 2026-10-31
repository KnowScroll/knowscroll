/**
 * The Hodgkin-Huxley model of a nerve cell's membrane (1952), the standard model of how an action potential
 * arises, with the common modern sign convention (the inside's voltage against the outside, about -65 mV at
 * rest). It is the squid giant axon at a cool temperature; a human neuron has other channels and numbers but the
 * same sequence, so the nerve kit (D-202) takes its shapes from this model and shows no figure.
 *
 * Voltage is in millivolts, time in milliseconds, current in microamps per square centimetre. Everything here is
 * deterministic and pure; the integration is fourth-order Runge-Kutta with a fixed step.
 */

const MEMBRANE_CAPACITANCE = 1;
const SODIUM_CONDUCTANCE = 120;
const POTASSIUM_CONDUCTANCE = 36;
const LEAK_CONDUCTANCE = 0.3;
/** The voltage at which each ion's flow would stop: the Nernst potentials of the model. No voltage can pass the sodium one or fall below the potassium one. */
export const SODIUM_REVERSAL = 50;
export const POTASSIUM_REVERSAL = -77;
const LEAK_REVERSAL = -54.387;

/** The membrane at one instant: its voltage and the three gates that decide how open the channels are. */
export interface MembraneState {
  readonly voltage: number;
  /** The sodium channel's activation gate (opens fast) and its inactivation gate (closes slowly). */
  readonly sodiumActivation: number;
  readonly sodiumAvailability: number;
  /** The potassium channel's activation gate (opens slowly). */
  readonly potassiumActivation: number;
}

/** A square pulse of current into the cell from `start` to `end`. */
export interface CurrentPulse {
  readonly start: number;
  readonly end: number;
  readonly current: number;
}

/** The share of the sodium channels that are open now. */
export const sodiumOpenShare = (state: MembraneState): number => state.sodiumActivation ** 3 * state.sodiumAvailability;

/** The share of the potassium channels that are open now. */
export const potassiumOpenShare = (state: MembraneState): number => state.potassiumActivation ** 4;

function safeRatio(x: number, scale: number, atZero: number): number {
  return Math.abs(x) < 1e-7 ? atZero : x / (1 - Math.exp(-x / scale));
}

const rates = (voltage: number) => ({
  mOpen: 0.1 * safeRatio(voltage + 40, 10, 10),
  mShut: 4 * Math.exp(-(voltage + 65) / 18),
  hOpen: 0.07 * Math.exp(-(voltage + 65) / 20),
  hShut: 1 / (1 + Math.exp(-(voltage + 35) / 10)),
  nOpen: 0.01 * safeRatio(voltage + 55, 10, 10),
  nShut: 0.125 * Math.exp(-(voltage + 65) / 80),
});

function derivative(state: MembraneState, injected: number): MembraneState {
  const { voltage, sodiumActivation: m, sodiumAvailability: h, potassiumActivation: n } = state;
  const rate = rates(voltage);
  const ionic =
    SODIUM_CONDUCTANCE * m ** 3 * h * (voltage - SODIUM_REVERSAL) +
    POTASSIUM_CONDUCTANCE * n ** 4 * (voltage - POTASSIUM_REVERSAL) +
    LEAK_CONDUCTANCE * (voltage - LEAK_REVERSAL);
  return {
    voltage: (injected - ionic) / MEMBRANE_CAPACITANCE,
    sodiumActivation: rate.mOpen * (1 - m) - rate.mShut * m,
    sodiumAvailability: rate.hOpen * (1 - h) - rate.hShut * h,
    potassiumActivation: rate.nOpen * (1 - n) - rate.nShut * n,
  };
}

const advance = (state: MembraneState, slope: MembraneState, step: number): MembraneState => ({
  voltage: state.voltage + slope.voltage * step,
  sodiumActivation: state.sodiumActivation + slope.sodiumActivation * step,
  sodiumAvailability: state.sodiumAvailability + slope.sodiumAvailability * step,
  potassiumActivation: state.potassiumActivation + slope.potassiumActivation * step,
});

/** One fourth-order Runge-Kutta step of `step` milliseconds with `injected` current held over it. */
export function stepMembrane(state: MembraneState, injected: number, step: number): MembraneState {
  const k1 = derivative(state, injected);
  const k2 = derivative(advance(state, k1, step / 2), injected);
  const k3 = derivative(advance(state, k2, step / 2), injected);
  const k4 = derivative(advance(state, k3, step), injected);
  const blend = (pick: (slope: MembraneState) => number): number =>
    (pick(k1) + 2 * pick(k2) + 2 * pick(k3) + pick(k4)) / 6;
  return advance(
    state,
    {
      voltage: blend((slope) => slope.voltage),
      sodiumActivation: blend((slope) => slope.sodiumActivation),
      sodiumAvailability: blend((slope) => slope.sodiumAvailability),
      potassiumActivation: blend((slope) => slope.potassiumActivation),
    },
    step,
  );
}

/** The integration step of the picture's traces, in milliseconds. */
export const TRACE_STEP = 0.01;

/** The membrane at rest: the state the gates settle to when nothing pushes. Computed once. */
let restingMembrane: MembraneState | undefined;
export function membraneAtRest(): MembraneState {
  if (restingMembrane === undefined) {
    let state: MembraneState = {
      voltage: -65,
      sodiumActivation: 0.05,
      sodiumAvailability: 0.6,
      potassiumActivation: 0.32,
    };
    for (let at = 0; at < 100; at += 0.02) state = stepMembrane(state, 0, 0.02);
    restingMembrane = state;
  }
  return restingMembrane;
}

/** What a run of the model gives: the state at every step from time 0, `TRACE_STEP` apart. */
export interface MembraneTrace {
  readonly states: readonly MembraneState[];
}

export const timeOf = (index: number): number => index * TRACE_STEP;

/** Runs the membrane from `start` for `duration` milliseconds under the pulses. */
export function runMembrane(
  pulses: readonly CurrentPulse[],
  duration: number,
  start: MembraneState = membraneAtRest(),
  from = 0,
): MembraneTrace {
  const states: MembraneState[] = [start];
  const steps = Math.round(duration / TRACE_STEP);
  let state = start;
  for (let index = 0; index < steps; index += 1) {
    const at = from + index * TRACE_STEP;
    const injected = pulses.reduce(
      (sum, pulse) => (at >= pulse.start && at < pulse.end ? sum + pulse.current : sum),
      0,
    );
    state = stepMembrane(state, injected, TRACE_STEP);
    states.push(state);
  }
  return { states };
}

/** Whether a trace holds a spike, one that rose past 0 mV after the cell had come back below -40 mV (or was never above it). */
export function hasSpikeAfter(trace: MembraneTrace, firstIndex = 0): boolean {
  let armed = false;
  for (let index = firstIndex; index < trace.states.length; index += 1) {
    const voltage = trace.states[index]?.voltage ?? 0;
    if (voltage < -40) armed = true;
    if (armed && voltage > 0) return true;
  }
  return false;
}
