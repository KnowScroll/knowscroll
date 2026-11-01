import { Module, type DynamicModule } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { reasoningProviders, personalRecordingReasoningProviders } from '@knowscroll/backend/reasoning/nest-providers';
import { FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { accountAccessProviders, accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import type { EnqueueJob, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { jobWiring } from './jobs.js';
import { ENQUEUE_JOB, DATABASE, LOG_EVENT, WITH_PERSONAL_SCOPE, WORKER_CONFIG, PG_BOSS } from './tokens.js';

const ACCOUNT_ACCESS = Symbol('worker.accountAccess');

/** Long-lived resources created by `main.ts` before Nest starts and closed after Nest stops. */
export interface WorkerResources {
  readonly enqueueJob: EnqueueJob;
  readonly config: WorkerConfig;
  readonly db: Kysely<Database>;
  readonly boss: ReturnType<typeof createBoss>;
  readonly logEvent: LogEvent;
}

/**
 * The worker composition root (blueprint §22): binds tokens to adapters and builds the explicit
 * consumer registry. The worker has no HTTP listener; HTTP guards never run here, so every
 * consumer's use case rechecks authority itself (under `withPersonalScope`).
 */
@Module({})
export class WorkerModule {
  static forRoot(resources: WorkerResources): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: WORKER_CONFIG, useValue: resources.config },
        { provide: ENQUEUE_JOB, useValue: resources.enqueueJob },
        { provide: DATABASE, useValue: resources.db },
        { provide: PG_BOSS, useValue: resources.boss },
        { provide: LOG_EVENT, useValue: resources.logEvent },
        {
          provide: WITH_PERSONAL_SCOPE,
          useValue: makeWithPersonalScope(resources.db, { lockTimeoutMs: resources.config.scopeLockTimeoutMs }),
        },
        // The actual Identity adapter owns the one account UPDATE gate. Its lifecycle reader
        // shares that private proof; no worker-local SQL or second account gate is substituted.
        {
          provide: ACCOUNT_ACCESS,
          useValue: accountAccessUseCases({ db: resources.db, lockTimeoutMs: resources.config.scopeLockTimeoutMs }),
        },
        ...accountAccessProviders({ useCases: ACCOUNT_ACCESS }),
        { provide: FENCE_PERSONAL_RECORDING, useValue: fencePersonalRecording },
        // The nonpersonal production and room harnesses. Every personal model step uses
        // RECORDING_REASONING_HARNESS and the actual owner proofs.
        ...reasoningProviders(
          { database: DATABASE, logEvent: LOG_EVENT },
          resources.config.reasoning,
          resources.config.scopeLockTimeoutMs,
        ),
        ...personalRecordingReasoningProviders(
          { database: DATABASE, withPersonalScope: WITH_PERSONAL_SCOPE, logEvent: LOG_EVENT },
          resources.config.reasoning,
        ),
        ...jobWiring,
      ],
    };
  }
}
