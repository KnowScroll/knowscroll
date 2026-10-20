/**
 * The one place the renderers load `@knowscroll/scroll-model` at run time. Importing it here, after
 * `./schema-runtime`, guarantees Zod is configured before the model builds a single schema (a source
 * test keeps every other file to `import type`).
 */
import './schema-runtime';

export * from '@knowscroll/scroll-model';
