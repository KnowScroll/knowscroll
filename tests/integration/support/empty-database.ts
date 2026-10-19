import { randomBytes } from 'node:crypto';
import { TEST_DATABASE_PREFIX, databaseUrl, quoteIdentifier, withAdmin } from './admin.js';

/** An empty database (no template) for proving the release's own migrate command. */
export async function createEmptyDatabase(purpose: string): Promise<{ readonly url: string; drop(): Promise<void> }> {
  const name = `${TEST_DATABASE_PREFIX}${purpose}_${randomBytes(4).toString('hex')}`;
  await withAdmin((client) => client.query(`create database ${quoteIdentifier(name)}`));
  return {
    url: databaseUrl(name),
    async drop() {
      await withAdmin((client) => client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`));
    },
  };
}
