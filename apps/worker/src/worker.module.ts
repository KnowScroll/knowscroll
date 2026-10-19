import { Module, type DynamicModule } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { jobConsumers } from './jobs.js';
import { DATABASE, JOB_CONSUMERS, LOG_EVENT, WORKER_CONFIG } from './tokens.js';

/** Long-lived resources created by `main.ts` before Nest starts and closed after Nest stops. */
export interface WorkerResources {
  readonly config: WorkerConfig;
  readonly db: Kysely<unknown>;
  readonly logEvent: LogEvent;
}

/**
 * The worker composition root (blueprint §22): binds tokens to adapters and builds the explicit
 * consumer registry. The worker has no HTTP listener; HTTP guards never run here, so every
 * consumer's use case rechecks authority itself.
 */
@Module({})
export class WorkerModule {
  static forRoot(resources: WorkerResources): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: WORKER_CONFIG, useValue: resources.config },
        { provide: DATABASE, useValue: resources.db },
        { provide: LOG_EVENT, useValue: resources.logEvent },
        { provide: JOB_CONSUMERS, useFactory: () => jobConsumers() },
      ],
    };
  }
}
