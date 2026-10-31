import type { GlobeAppearance, GlobePlacement } from '../animation/enter-planet';

/**
 * A camera script for the space view: "Enter a system" or "Enter a planet" (D-114). The renderer does not
 * know what the animation means. It is given the clock of the animation, poses the camera and the few
 * props in the scene (the rocket, the parked ship, the glow of a close planet) from that clock, and
 * reports what the screen needs to lay its own drawing over the 3D one. The clock is the animation
 * player's `t`, so a frame is a pure function of it.
 */
export interface SpaceScript {
  readonly kind: 'enter-system' | 'enter-planet';
  /** The system being entered, or the system the planet is in. */
  readonly systemId: string;
  /** Enter-planet: the planet. */
  readonly planetId?: string;
  /** Enter-planet: the planet has rings or a moon, which are turned into the planet view's on the way in. */
  readonly ringed?: boolean;
  /** Enter-planet: where the planet view puts its globe, so the glide ends exactly there. */
  readonly globe?: GlobePlacement;
  /** Seconds into the animation, read at every frame. */
  readonly clock: () => number;
  /** Called after each frame is drawn, with what the screen needs to lay its own drawing over the scene. */
  readonly onFrame?: (frame: ScriptFrame) => void;
}

export interface ScriptFrame {
  readonly t: number;
  /** Enter-planet: the planet on the screen this frame, and how its globe is drawn over it. */
  readonly planet?: {
    readonly x: number;
    readonly y: number;
    readonly radiusPx: number;
    readonly appearance: GlobeAppearance;
  };
  /** Enter-system: the system on the screen this frame, for the tap ring. */
  readonly system?: { readonly x: number; readonly y: number };
}
