/**
 * The one place the renderers load `@knowscroll/scroll-model` at run time. Importing it here, after
 * `./schema-runtime`, guarantees Zod is configured before the model builds a single schema (a source
 * test keeps every other file to `import type`). The names are listed one by one, never `export *`,
 * so the admission functions the model still exports for compatibility cannot slip through the door
 * onto a device (ESLint refuses them by name in this package; see the root `eslint.config.js`).
 */
import './schema-runtime';

export {
  BLOCK_TYPES,
  BLOCK_VERSIONS,
  INTEGRITY_METHOD,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  SCROLL_LIMITS_VERSION,
  blockStateProblems,
  canonicalJson,
  computeIntegrity,
  computeMeasures,
  defaultBlockState,
  fallbackTextOf,
  findBlock,
  isGraphemeBoundary,
  isInteractiveBlock,
  negotiate,
  parseBlock,
  parseDocument,
  walkBlocks,
} from '@knowscroll/scroll-model';

export type {
  AnyBlock,
  Block,
  BlockOfType,
  BlockState,
  BlockType,
  ClientCapabilities,
  DocumentOutcome,
  Issue,
  NestedBlock,
  ScrollDocument,
  Section,
  Span,
} from '@knowscroll/scroll-model';
