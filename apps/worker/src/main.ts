import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigurationError, readWorkerConfig, worldForDiagnostics } from '@knowscroll/backend/infrastructure/config';
import {
  makeEnqueueJob,
  createBoss,
  drainConsumers,
  startConsumers,
  type JobConsumer,
} from '@knowscroll/backend/infrastructure/jobs';
import { runProcess } from '@knowscroll/backend/infrastructure/lifecycle';
import { FrameworkLogAdapter, createEventLog } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { JOB_CONSUMERS } from './tokens.js';
import { WorkerModule } from './worker.module.js';

/**
 * Worker process entry point: a Nest application context (no network listener) whose consumers
 * pg-boss drives. Stop order: stop claiming and drain running handlers (bounded), then close the
 * Nest context, then the database pool.
 */
async function main(): Promise<void> {
  const bootLog = createEventLog({
    service: 'worker',
    environment: worldForDiagnostics(process.env),
    revision: 'unknown',
  });
  let config;
  try {
    config = readWorkerConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) bootLog('config.invalid', { problems: error.problems });
    else bootLog('process.start_failed', { reasonCode: 'config_failed', error });
    process.exit(1);
  }
  const logEvent = createEventLog({ service: 'worker', environment: config.world, revision: config.commit });

  await runProcess({
    logEvent,
    shutdownGraceMs: config.shutdownGraceMs + 5_000,
    async start() {
      const database = createDatabase<Database>(config.database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      const boss = createBoss(config.database, 'consumer', {
        onError: (error) => logEvent('jobs.error', { error }),
        onWarning: (reasonCode) => logEvent('jobs.warning', { reasonCode }),
      });
      await boss.start();
      const app = await NestFactory.createApplicationContext(
        WorkerModule.forRoot({ config, db: database.db, boss, logEvent, enqueueJob: makeEnqueueJob(boss) }),
        {
          logger: new FrameworkLogAdapter(logEvent),
          abortOnError: false,
        },
      );
      const consumers = app.get<readonly JobConsumer<unknown>[]>(JOB_CONSUMERS);
      await startConsumers(boss, consumers, logEvent);
      return {
        async stop() {
          await drainConsumers(boss, consumers.length, config.shutdownGraceMs, logEvent);
          await app.close();
          await database.close();
        },
      };
    },
  });
}

await main();
