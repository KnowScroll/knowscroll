import { ConfigurationError, readMigrateConfig, worldForDiagnostics } from '@knowscroll/backend/infrastructure/config';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { createEventLog } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, migrateToLatest } from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations } from '@knowscroll/migrations';
import { declaredQueues } from './queues.js';

/**
 * `node dist/migrate.js`: applies pending reviewed SQL migrations, installs or upgrades the
 * pg-boss schema and applies every declared queue's policy. Run by the deploy tool before the
 * new release starts (after a verified backup in live, CF-27). Exit status 0 means the database
 * is ready for this release.
 */
async function main(): Promise<number> {
  const logEvent = createEventLog({
    service: 'migrate',
    environment: worldForDiagnostics(process.env),
    revision: 'unknown',
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
    const outcome = await migrateToLatest(database.db, migrations);
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
    await boss.start();
    try {
      await applyQueueDeclarations(boss, declaredQueues);
    } finally {
      await boss.stop({ graceful: false });
    }
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
