import type { Provider } from '@nestjs/common';
import { madeToOrderProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { READ_ORDER_AUDIENCE } from '@knowscroll/backend/modules/content';
import { scenarioProviders } from '@knowscroll/backend/modules/scenarios/nest-providers';
import { scenarioOrderProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { API_CONFIG, DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Scenarios for the API composition root (D-049): the use cases behind the HTTP routes, Quartermaster's
 * Create for a chosen branch, and the audience content asks before it opens a Scroll made for a thread.
 * Needs Social's thread guest and content's reads, which the social and content wiring provide.
 */
export const scenarioWiring: Provider[] = [
  ...scenarioProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, database: DATABASE, enqueueJob: ENQUEUE_JOB }),
  ...scenarioOrderProviders({ enqueueJob: ENQUEUE_JOB, config: API_CONFIG }),
  ...madeToOrderProviders({ database: DATABASE, orderAudience: READ_ORDER_AUDIENCE }),
];
