import pg from 'pg';

/**
 * The integration suite needs a disposable PostgreSQL 16 server. `KS_TEST_DATABASE_URL` names a
 * role that may create databases (CI: the `postgres:16` service). The suite creates and drops
 * only databases whose names start with `ks_it_`; it never touches any other database.
 */
export function adminUrl(): string {
  const url = process.env['KS_TEST_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('KS_TEST_DATABASE_URL must name a disposable PostgreSQL server for the integration suite');
  }
  return url;
}

/** The URL of database `name` on the admin server. */
export function databaseUrl(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export const TEST_DATABASE_PREFIX = 'ks_it_';

/** Runs `fn` with a short-lived admin connection to the server's maintenance database. */
export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl(), application_name: 'knowscroll-integration-admin' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function quoteIdentifier(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}
