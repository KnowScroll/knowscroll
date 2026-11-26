/**
 * Loads the crossing's three.js renderer and shader on first use, so they stay out of the bundle every other screen
 * loads. A module of its own so a test can stand in for the GPU side.
 */
export const loadCrossingRenderer = () => import('./crossing-renderer');
