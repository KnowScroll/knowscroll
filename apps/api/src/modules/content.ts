import type { Provider } from '@nestjs/common';
import {
  catalogueProviders,
  contentProviders,
  contentRenderProviders,
  makeOperatorReview,
  makeReadLibraryFinds,
} from '@knowscroll/backend/modules/content/nest-providers';
import { OPERATOR_REVIEW, READ_LIBRARY_FINDS, type OperatorReview } from '@knowscroll/backend/modules/content';
import { IS_OPERATOR, type IsOperator } from '@knowscroll/backend/modules/operator';
import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import { API_CONFIG, DATABASE } from '../tokens.js';

/**
 * Content wiring for the API composition root: the scope-bound read ports experience and evidence
 * use inside a personal transaction, the document renderer (shared reads outside one) and the operator's review of held Scrolls.
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
  // The operator's review screen (#780): the review gate behind the operator check of `KS_OPERATOR_ACCOUNTS`, which the use case runs on every call.
  {
    provide: OPERATOR_REVIEW,
    inject: [DATABASE, IS_OPERATOR, API_CONFIG],
    useFactory: (db: Kysely<Database>, isOperator: IsOperator, config: ApiConfig): OperatorReview =>
      makeOperatorReview({ db, isOperator, world: config.world }),
  },
];

/**
 * The operator command's use case (`dist/operator.js content import-editorial`), over its own
 * database handle. Re-exported here because only composition roots choose concrete implementations.
 */
export { importEditorialScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
