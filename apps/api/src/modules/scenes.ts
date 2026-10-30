import type { Provider } from '@nestjs/common';
import { sceneProviders, formationProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { WITH_PERSONAL_SCOPE, DATABASE, PG_BOSS, LOG_EVENT } from '../tokens.js';

/** Explicit read/claim/ack composition; only the worker consumes expiry/recovery jobs. */
export const sceneWiring: Provider[] = [
  ...sceneProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, logEvent: LOG_EVENT }),
  ...formationProviders({ database: DATABASE, boss: PG_BOSS, withPersonalScope: WITH_PERSONAL_SCOPE }),
];
