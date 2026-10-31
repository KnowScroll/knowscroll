import type { Provider } from '@nestjs/common';
import { madeToOrderProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { READ_ASK_ORDER_AUDIENCE, READ_ORDER_AUDIENCE } from '@knowscroll/backend/modules/content';
import { scenarioProviders } from '@knowscroll/backend/modules/scenarios/nest-providers';
import { askOrderAudienceProviders, scenarioOrderProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { API_CONFIG, DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Scenarios for the API composition root (D-049): the use cases behind the HTTP routes, Quartermaster's
 * Create for a chosen branch, and the audiences content asks before it opens a Scroll made to order: a thread's
 * members for a branch (D-049), the person who asked for an ask order (D-218).
 * Needs Social's thread guest and content's reads, which the social and content wiring provide.
 */
export const scenarioWiring: Provider[] = [
  ...scenarioProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, database: DATABASE, enqueueJob: ENQUEUE_JOB }),
  ...scenarioOrderProviders({ enqueueJob: ENQUEUE_JOB, config: API_CONFIG }),
  ...askOrderAudienceProviders({ database: DATABASE }),
  ...madeToOrderProviders({ database: DATABASE, orderAudiences: [READ_ORDER_AUDIENCE, READ_ASK_ORDER_AUDIENCE] }),
];
