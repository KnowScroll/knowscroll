/**
 * The one check `scripts/demo-populate.ts` must run before it opens any database connection.
 *
 * This module imports nothing from `pg` or `packages/db`, on purpose: importing either of those
 * modules constructs connection machinery as a side effect of the import itself, so the guard has
 * to live somewhere that can be evaluated in complete isolation from them. `demo-populate.ts` calls
 * `assertDemoDatabaseName` as its first statement, before any `import(...)` of a database module,
 * so a database whose name does not begin `knowscroll_demo_` is refused before a socket is ever
 * opened towards it — never merely before a write.
 *
 * Tested directly (as a pure function, no database, no process) and via a subprocess smoke test in
 * `tests/demo-populate-guard.test.ts`.
 */

const REQUIRED_PREFIX = 'knowscroll_demo_';

export class NotADemoDatabaseError extends Error {
  constructor(databaseName: string) {
    super(
      `Refusing to run: database "${databaseName}" does not begin "${REQUIRED_PREFIX}". ` +
        'demo-populate.ts only ever runs against a disposable knowscroll_demo_* database — ' +
        'never the owner database, a knowscroll_test_* database, or any other name.',
    );
    this.name = 'NotADemoDatabaseError';
  }
}

/**
 * Parses `databaseUrl` and returns its database name once it has been proven to start with
 * `knowscroll_demo_`. Throws `NotADemoDatabaseError` (or a plain `Error` for a malformed URL)
 * otherwise. Never logs or otherwise reproduces `databaseUrl` itself — a Postgres connection string
 * carries a password, and only the database name (never a secret) is safe to put in a message.
 */
export function assertDemoDatabaseName(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error('DATABASE_URL must be set (see scripts/demo-populate.ts header for invocation).');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL.');
  }
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (!databaseName.startsWith(REQUIRED_PREFIX)) throw new NotADemoDatabaseError(databaseName);
  // Belt and braces: the name must also be a safe SQL identifier before it is ever interpolated
  // into a CREATE DATABASE statement.
  if (!/^[a-z0-9_]+$/i.test(databaseName)) {
    throw new Error(`Database name "${databaseName}" contains characters this tool will not interpolate into SQL.`);
  }
  return databaseName;
}
