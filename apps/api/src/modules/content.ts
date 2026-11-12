import type { Provider } from '@nestjs/common';
import {
  catalogueProviders,
  contentProviders,
  contentRenderProviders,
  makeReadLibraryFinds,
} from '@knowscroll/backend/modules/content/nest-providers';
import { READ_LIBRARY_FINDS } from '@knowscroll/backend/modules/content';
import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { DATABASE } from '../tokens.js';

/**
 * Content wiring for the API composition root: the scope-bound read ports experience and evidence
 * use inside a personal transaction, and the document renderer (shared reads outside one).
 */
export const contentWiring: Provider[] = [
  ...contentProviders(),
  // The topic catalogue (D-419), read by every module that names a topic: rooms, scenes, supply, geography and the Composer.
  ...catalogueProviders({ database: DATABASE }),
  ...contentRenderProviders({ database: DATABASE }),
  // A system's Reels and Scrolls (#697) read the shared library outside any transaction; the worker mounts the rest of it.
  {
    provide: READ_LIBRARY_FINDS,
    inject: [DATABASE],
    useFactory: (db: Kysely<Database>) => makeReadLibraryFinds(db),
  },
];

/**
 * The operator command's use case (`dist/operator.js content import-editorial`), over its own
 * database handle. Re-exported here because only composition roots choose concrete implementations.
 */
export { importEditorialScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
