import { z } from 'zod';

/**
 * Zod compiles object parsers with `new Function` unless told not to, and probes for it the first
 * time a schema is built. The web app's Content-Security-Policy allows no `eval` (review m7), so
 * the probe would be refused and reported as a policy violation on every page load. The contracts
 * are small; every process that loads them parses without the compiler. This module must be the
 * first one `index.ts` evaluates, before any schema exists.
 */
z.config({ jitless: true });
