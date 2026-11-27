/**
 * Times each flight of the camera for the frame-rate readout (`frame-rate/`), from the moment it was asked for to the
 * first frame drawn at rest. Pure apart from the clock it is handed, and free of three.js: the controller holds it.
 */
import type { FlightLeg } from '../frame-rate/frame-meter';
import { targetKey, type VoyageTarget } from './ladder';

/** The flights of one screen. */
export interface FlightLegs {
  /**
   * The person asked to go to `target` at `nowMs` (a tap, a key, a pinch let go), or the screen began a fall into it.
   * `label` names the leg in place of its stop's name.
   */
  asked(target: VoyageTarget, nowMs: number, label?: string): void;
  /**
   * A frame was drawn at `nowMs`, in flight or not, with `programs` shader programs held by three.js. Returns the flight
   * that has just landed, or null. Under reduced motion the first frame after the ask is at rest: a cut.
   */
  frame(flying: boolean, programs: number, nowMs: number): FlightLeg | null;
}

/** Times the flights of a screen that opened at `first`. */
export function createFlightLegs(first: VoyageTarget): FlightLegs {
  /** The places flown to so far: a flight to one again is labelled so, as nothing new is linked or painted. */
  const visited = new Set([targetKey(first)]);
  let programs = 0;
  let open: { label: string; startMs: number; programs: number } | null = null;
  return {
    asked(target, nowMs, label) {
      const key = targetKey(target);
      open = { label: label ?? (visited.has(key) ? `${target.stop} again` : target.stop), startMs: nowMs, programs };
      visited.add(key);
    },
    frame(flying, programsNow, nowMs) {
      programs = programsNow;
      if (open === null || flying) return null;
      const landed: FlightLeg = {
        label: open.label,
        startMs: open.startMs,
        endMs: nowMs,
        programsLinked: Math.max(0, programsNow - open.programs),
      };
      open = null;
      return landed;
    },
  };
}
