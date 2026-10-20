import { z } from 'zod';

/**
 * Configure before constructing any Scroll schema: Zod otherwise probes `Function` during
 * object construction, even if parsing later passes `{ jitless: true }`. A caught CSP error
 * still emits a security-policy violation in the browser. This deliberately disables Zod's
 * dynamic compilation for the whole realm, including schemas constructed by other packages
 * afterwards. Validation semantics are identical; CI measures admission with this setting.
 * Keep this module in package.json's sideEffects list so bundlers preserve the configuration.
 */
z.config({ jitless: true });

export { z };
