import { smoothstep } from './easing';

/**
 * Going back up (D-093, D-116): every step up, planet to its system, a planet's map to its globe, a system to the whole
 * map, is a 0.3 s cross-fade, not the forward animation backwards. The screen being left fades out over the screen being
 * entered, and both are live: nothing here is a picture.
 */
export const STEP_UP_SECONDS = 0.3;

/** How far the cross-fade has gone, 0 to 1: the new screen's share. */
export const crossFadeAt = (t: number): number => smoothstep(0, STEP_UP_SECONDS, t);
