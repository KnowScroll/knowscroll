/**
 * Loads the three.js renderer on first use, so its code (about 200 KB gzipped) stays out of the
 * bundle every other screen loads. A module of its own so tests can stand in for the GPU side.
 */
export const loadSpaceRenderer = () => import('./space-renderer');

/**
 * Loads the first open's renderer on first use, for the one account lifetime it plays in (D-114). It is told the animation's
 * clock, so the picture is a pure function of the animation's `t`.
 */
export const loadFirstOpenRenderer =
  (clock: () => number): typeof loadSpaceRenderer =>
  () =>
    import('./first-open-renderer').then((module) => ({
      createSpaceRenderer: (surface) => module.createFirstOpenRenderer(surface, clock),
    }));
