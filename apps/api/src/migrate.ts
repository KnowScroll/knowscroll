import {
  ConfigurationError,
  commitForDiagnostics,
  readMigrateConfig,
  worldForDiagnostics,
} from '@knowscroll/backend/infrastructure/config';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { createEventLog } from '@knowscroll/backend/infrastructure/observability';
import {
  createDatabase,
  createOpsJobViews,
  dropOpsJobViews,
  grantOpsReader,
  migrateToLatest,
} from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations } from '@knowscroll/migrations';
import { declaredQueues } from './queues.js';

/**
 * `node dist/migrate.js`: applies pending reviewed SQL migrations, installs or upgrades the
 * pg-boss schema, applies every declared queue's policy and schedule, and removes the schedule of any
 * queue that is no longer declared. Run by the deploy tool before the
 * new release starts (after a verified backup in live, CF-27). It also rebuilds the `ops` views that
 * read pg-boss's tables and grants the read-only operator role, when that role exists. Exit status 0
 * means the database is ready for this release.
 */
async function main(): Promise<number> {
  const logEvent = createEventLog({
    service: 'migrate',
    environment: worldForDiagnostics(process.env),
    revision: commitForDiagnostics(process.env),
  });
  let config;
  try {
    config = readMigrateConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('migrate.failed', { error });
    return 1;
  }
  const startedAt = Date.now();
  const database = createDatabase<unknown>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
  });
  try {
    const migrations = loadMigrations();
    logEvent('migrate.started', { count: migrations.length });
    // The ops views that read pg-boss's tables would block its schema upgrade; they are rebuilt below.
    await dropOpsJobViews(database.db);
    const outcome = await migrateToLatest(database.db, migrations);
    if (outcome.kind === 'refused') {
      logEvent('migrate.failed', { migration: outcome.migration, reasonCode: outcome.reason });
      return 1;
    }
    if (outcome.kind === 'failed') {
      logEvent('migrate.failed', {
        ...(outcome.failedMigration === undefined ? {} : { migration: outcome.failedMigration }),
        error: outcome.error,
      });
      return 1;
    }
    const boss = createBoss(config.database, 'install', {
      onError: (error) => logEvent('jobs.error', { error }),
      onWarning: (reasonCode) => logEvent('jobs.warning', { reasonCode }),
    });
    try {
      await boss.start();
      for (const removed of await applyQueueDeclarations(boss, declaredQueues))
        logEvent('jobs.schedule_removed', { queue: removed.queue });
    } finally {
      await boss.stop({ graceful: false });
    }
    await createOpsJobViews(database.db);
    if ((await grantOpsReader(database.db)) === 'role_missing')
      logEvent('migrate.warning', { reasonCode: 'ops_reader_role_missing' });
    logEvent('migrate.completed', {
      count: outcome.applied.length,
      migration: outcome.latest,
      durationMs: Date.now() - startedAt,
    });
    return 0;
  } catch (error) {
    logEvent('migrate.failed', { error });
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
