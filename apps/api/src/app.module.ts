import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { selectCallers } from './http/callers.js';
import { orpcModuleConfig } from './http/orpc.js';
import { ProblemExceptionFilter } from './http/problems.js';
import { experienceWiring } from './modules/experience.js';
import { ScopeGateway } from './realtime/scope.gateway.js';
import { apiControllers } from './routes.js';
import { API_CONFIG, CALLERS, DATABASE, ENQUEUE_JOB, LOG_EVENT, WITH_PERSONAL_SCOPE } from './tokens.js';

/** Long-lived resources created by `main.ts` before Nest starts and closed after Nest stops. */
export interface ApiResources {
  readonly config: ApiConfig;
  readonly db: Kysely<Database>;
  readonly enqueueJob: EnqueueJob;
  readonly logEvent: LogEvent;
}

/**
 * The API composition root (blueprint §22). It binds every token to a concrete adapter and lists
 * the controllers and the gateway; nothing else constructs dependencies.
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
        {
          provide: WITH_PERSONAL_SCOPE,
          useValue: makeWithPersonalScope(resources.db, { lockTimeoutMs: resources.config.scopeLockTimeoutMs }),
        },
        {
          provide: CALLERS,
          useValue: selectCallers(resources.config.authAdapter, resources.config.nodeEnv, resources.db),
        },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        ...experienceWiring,
        ScopeGateway,
      ],
    };
  }
}
