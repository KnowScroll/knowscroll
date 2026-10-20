import { contentProviders, contentRenderProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { DATABASE } from '../tokens.js';

/**
 * Content wiring for the API composition root: the scope-bound read ports experience and evidence
 * use inside a personal transaction, and the document renderer (shared reads outside one).
 */
export const contentWiring = [...contentProviders(), ...contentRenderProviders({ database: DATABASE })];

/**
 * The operator command's use case (`dist/operator.js content import-editorial`), over its own
 * database handle. Re-exported here because only composition roots choose concrete implementations.
 */
export { importEditorialScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
