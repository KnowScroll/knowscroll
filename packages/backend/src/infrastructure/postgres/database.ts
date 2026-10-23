import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DatabaseSettings } from '../config/index.js';
import type { DB } from './database.generated.js';

/** The workspace's database schema, generated from the migrated database by kysely-codegen. */
export type Database = DB;

/** A process's database access: the Kysely instance, its pool, and one way to close both. */
export interface DatabaseHandle<DB> {
  readonly db: Kysely<DB>;
  readonly pool: pg.Pool;
  /** Ends every pooled connection. Call once, after admission and job claims have stopped. */
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Receives errors from idle pooled connections, which would otherwise crash the process. */
  readonly onIdleClientError: (error: Error) => void;
}

/**
 * Creates the pool and Kysely instance for one process.
 *
 * Every connection sets `application_name` (visible in `pg_stat_activity`), a statement timeout
 * and an idle-in-transaction timeout, so a stuck transaction cannot hold the personal-scope lock
 * forever. `settings.url` carries credentials and is passed only to the driver.
 */
export function createDatabase<DB>(settings: DatabaseSettings, options: CreateDatabaseOptions): DatabaseHandle<DB> {
  const pool = new pg.Pool({
    connectionString: settings.url,
    application_name: settings.applicationName,
    max: settings.poolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: settings.statementTimeoutMs,
    idle_in_transaction_session_timeout: Math.max(settings.statementTimeoutMs * 2, 60_000),
  });
  pool.on('error', options.onIdleClientError);
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  let closed = false;
  return {
    db,
    pool,
    async close() {
      if (closed) return;
      closed = true;
      // Kysely's destroy ends the pool it was given.
      await db.destroy();
    },
  };
}
