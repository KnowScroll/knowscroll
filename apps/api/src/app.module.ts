import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import type { RelayState } from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { READ_ACCOUNT_UNIVERSE, type ReadAccountUniverse } from '@knowscroll/backend/modules/identity';
import { selectCallers } from './http/callers.js';
import { orpcModuleConfig } from './http/orpc.js';
import { ProblemExceptionFilter } from './http/problems.js';
import { contentWiring } from './modules/content.js';
import { experienceWiring } from './modules/experience.js';
import { identityWiring } from './modules/identity.js';
import { ScopeGateway } from './realtime/scope.gateway.js';
import { apiControllers } from './routes.js';
import { API_CONFIG, CALLERS, DATABASE, ENQUEUE_JOB, LOG_EVENT, RELAY_STATE, WITH_PERSONAL_SCOPE } from './tokens.js';

/** Long-lived resources created by `main.ts` before Nest starts and closed after Nest stops. */
export interface ApiResources {
  readonly config: ApiConfig;
  readonly db: Kysely<Database>;
  readonly enqueueJob: EnqueueJob;
  readonly logEvent: LogEvent;
  readonly relayState: () => RelayState;
}

/**
 * The API composition root (blueprint §22). It binds every token to a concrete adapter (or a
 * module's nest-providers) and lists the controllers and the gateway; nothing else constructs
 * dependencies.
 */
@Module({})
export class AppModule {
  static forRoot(resources: ApiResources): DynamicModule {
    return {
      module: AppModule,
      imports: [ORPCModule.forRoot(orpcModuleConfig(resources.logEvent))],
      controllers: apiControllers,
      providers: [
        { provide: API_CONFIG, useValue: resources.config },
        { provide: DATABASE, useValue: resources.db },
        { provide: LOG_EVENT, useValue: resources.logEvent },
        { provide: ENQUEUE_JOB, useValue: resources.enqueueJob },
        { provide: RELAY_STATE, useValue: resources.relayState },
        {
          provide: WITH_PERSONAL_SCOPE,
          useValue: makeWithPersonalScope(resources.db, { lockTimeoutMs: resources.config.scopeLockTimeoutMs }),
        },
        {
          provide: CALLERS,
          inject: [READ_ACCOUNT_UNIVERSE],
          useFactory: (readAccountUniverse: ReadAccountUniverse) =>
            selectCallers(resources.config.authAdapter, resources.config, readAccountUniverse),
        },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        ...identityWiring,
        ...contentWiring,
        ...experienceWiring,
        ScopeGateway,
      ],
    };
  }
}
