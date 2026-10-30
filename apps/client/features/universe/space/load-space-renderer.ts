/**
 * Loads the three.js renderer on first use, so its code (about 200 KB gzipped) stays out of the
 * bundle every other screen loads. A module of its own so tests can stand in for the GPU side.
 */
export const loadSpaceRenderer = () => import('./space-renderer');
