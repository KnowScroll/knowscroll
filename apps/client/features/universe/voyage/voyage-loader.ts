/**
 * The seam between the trial's stage and three.js. The stage and the controller reach the main bundle, the driver does
 * not, so the driver is loaded here, on the first draw, and handed to the map's renderer.
 */
import type { loadSpaceRenderer } from '../space/load-space-renderer';
import type { VoyageControl } from './voyage-control';

/**
 * Loads the map's own renderer with the trial's camera driving it, on first use. Both are imported on demand, and
 * three.js comes in with them, so none of it is in the bundle every other screen loads: this file is the only place the
 * driver is imported at runtime.
 */
export const loadVoyageRenderer =
  (control: VoyageControl): typeof loadSpaceRenderer =>
  () =>
    Promise.all([import('../space/space-renderer'), import('./voyage-driver')]).then(([space, voyage]) => ({
      ...space,
      createSpaceRenderer: (surface, definition, options) =>
        space.createSpaceRenderer(surface, definition, { ...options, driver: voyage.createVoyageDriver(control) }),
    }));
