import type { loadSpaceRenderer } from '../space/load-space-renderer';
import type { VoyageControl } from './voyage-driver';

/**
 * Loads the map's own renderer with the Round 7.3 camera driving it, on first use. Both come in one lazy chunk with
 * three.js, so none of it is in the bundle every other screen loads.
 */
export const loadVoyageRenderer =
  (control: VoyageControl): typeof loadSpaceRenderer =>
  () =>
    Promise.all([import('../space/space-renderer'), import('./voyage-driver')]).then(([space, voyage]) => ({
      ...space,
      createSpaceRenderer: (surface, definition, options) =>
        space.createSpaceRenderer(surface, definition, { ...options, driver: voyage.createVoyageDriver(control) }),
    }));
