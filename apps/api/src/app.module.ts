import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { orpcModuleConfig } from './http/orpc.js';
import { ProblemExceptionFilter } from './http/problems.js';
import { apiControllers } from './routes.js';
import { API_CONFIG, DATABASE, LOG_EVENT } from './tokens.js';

/** Long-lived resources created by `main.ts` before Nest starts and closed after Nest stops. */
export interface ApiResources {
  readonly config: ApiConfig;
  readonly db: Kysely<unknown>;
  readonly logEvent: LogEvent;
}

/**
 * The API composition root (blueprint §22). It binds tokens to concrete adapters and lists the
 * controllers; nothing else constructs dependencies.
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
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
      ],
    };
  }
}
