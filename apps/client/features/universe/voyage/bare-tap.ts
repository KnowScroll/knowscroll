/**
 * What a tap on the planet's land does when it is not on a name: the one decision both the planet stop and the ground
 * make, apart from the screen. A name is its own button and wins before this is asked; this is the tap that missed it.
 *
 * The land answers only where it is an opened region (`ground-hit.ts`): the sea and land not reached answer nobody, so
 * they never open anything and never say that closed land is there (D-109).
 */
import type { Stop } from './ladder';

/** What the tap does. */
export type BareTap =
  /** Focus this region, exactly as a tap on its name does. */
  | { readonly kind: 'region'; readonly id: string }
  /** Land on the planet: one stop down, to its ground (the planet stop's "tap to land"). */
  | { readonly kind: 'land' }
  /** Open the map of the whole planet (the ground's bare ground). */
  | { readonly kind: 'map' }
  /** Nothing: the tap landed where nothing answers. */
  | { readonly kind: 'nothing' };

const NOTHING: BareTap = { kind: 'nothing' };

/** What the screen knows of the tap besides what is under it. */
export interface BareTapScene {
  /** This planet's map can open from here. */
  readonly mapOpens: boolean;
  /** The tap is on the globe's disc (the planet stop only); the sky round it is not. */
  readonly onGlobe: boolean;
}

/**
 * `stop` is where the camera is and `regionId` the opened region under the tap (null for the sea, land not reached, or
 * anywhere off the globe). An opened region is focused at the planet stop and on the ground. Elsewhere on the globe the
 * planet stop lands on the planet and the ground opens the map, where one can; the sky round the globe does nothing.
 * No other stop has land to tap.
 */
export function bareTapOf(stop: Stop, regionId: string | null, scene: BareTapScene): BareTap {
  if (stop !== 'planet' && stop !== 'ground') return NOTHING;
  if (regionId !== null) return { kind: 'region', id: regionId };
  if (stop === 'planet') return scene.onGlobe ? { kind: 'land' } : NOTHING;
  return scene.mapOpens ? { kind: 'map' } : NOTHING;
}
