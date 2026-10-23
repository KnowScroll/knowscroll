import { z } from 'zod';

/**
 * `@knowscroll/scroll-model` builds its Zod schemas when it is first loaded, and Zod probes for
 * `new Function` while it builds them. The web app's Content-Security-Policy allows no `eval`
 * (S1.3 review m7), so the probe is refused and reported as a policy violation on every page that
 * loads the module. The contracts package configures Zod first for the same reason; the renderers
 * load the model through `./model`, which loads this file first, so the order does not depend on
 * what the app happens to import before. The document is small and parsed once per revision.
 */
z.config({ jitless: true });
