import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { createDatabase, migrateToLatest } from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations } from '@knowscroll/migrations';
import { TEST_DATABASE_PREFIX, databaseUrl, quoteIdentifier, withAdmin } from './admin.js';
import { testQueues } from './queues.js';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

/**
 * Builds one template database for the run: every registered migration, pg-boss's schema and
 * the test queues. Each test file then clones it (`CREATE DATABASE … TEMPLATE`), so files are
 * isolated and start from the exact production schema.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const template = `${TEST_DATABASE_PREFIX}template_${randomBytes(4).toString('hex')}`;
  await withAdmin((client) => client.query(`create database ${quoteIdentifier(template)}`));
  const settings = {
    url: databaseUrl(template),
    applicationName: 'knowscroll-integration-setup',
    poolMax: 2,
    statementTimeoutMs: 60_000,
  };
  const database = createDatabase<unknown>(settings, {
    onIdleClientError: (error) => {
      throw error;
    },
  });
  try {
    const outcome = await migrateToLatest(database.db, loadMigrations());
    if (outcome.kind === 'failed')
      throw new Error(`Template migration failed at ${outcome.failedMigration ?? 'unknown'}`, { cause: outcome.error });
  } finally {
    await database.close();
  }
  const boss = createBoss(settings, 'install', {
    onError: (error) => {
      throw error;
    },
    onWarning: () => undefined,
  });
  await boss.start();
  await applyQueueDeclarations(boss, testQueues);
  await boss.stop({ graceful: false });
  project.provide('templateDatabase', template);

  return async () => {
    await withAdmin(async (client) => {
      const leftovers = await client.query<{ datname: string }>(
        'select datname from pg_database where datname like $1',
        [`${TEST_DATABASE_PREFIX}%`],
      );
      for (const row of leftovers.rows)
        await client.query(`drop database if exists ${quoteIdentifier(row.datname)} with (force)`);
    });
  };
}
