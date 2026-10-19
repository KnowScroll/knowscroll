import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import type { DatabaseSettings } from '@knowscroll/backend/infrastructure/config';
import { createDatabase, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { databaseUrl, quoteIdentifier, withAdmin } from './admin.js';

/** A database cloned from the run's migrated template, owned by one test file. */
export interface TestDatabase<DB = unknown> extends DatabaseHandle<DB> {
  readonly name: string;
  readonly settings: DatabaseSettings;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

/** Clones the template database. Call once per test file (in `beforeAll`) and `drop()` after. */
export async function createTestDatabase<DB = unknown>(purpose: string): Promise<TestDatabase<DB>> {
  const template = inject('templateDatabase');
  const name = `${inject('runPrefix')}${purpose.replaceAll(/[^a-z0-9]+/g, '_').slice(0, 30)}_${randomBytes(4).toString('hex')}`;
  await withAdmin((client) =>
    client.query(`create database ${quoteIdentifier(name)} template ${quoteIdentifier(template)}`),
  );
  const settings: DatabaseSettings = {
    url: databaseUrl(name),
    applicationName: `knowscroll-it-${purpose}`.slice(0, 60),
    poolMax: 5,
    statementTimeoutMs: 20_000,
  };
  const handle = createDatabase<DB>(settings, {
    onIdleClientError: () => {
      // Tests that terminate backends on purpose produce idle-client errors; assertions cover them.
    },
  });
  return {
    ...handle,
    name,
    settings,
    async drop() {
      await handle.close();
      await withAdmin((client) => client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`));
    },
  };
}
