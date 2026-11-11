import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { releaseDirectory, startReleaseProcess } from '../support/processes.js';

/**
 * `operator.js geography dry-run` and `planner dry-run` from the built worker tree (#674, D-411): what a run would do for
 * one universe, from a server shell, read-only, counts and codes only. Evidence label: CI fixture rows in a real database;
 * no provider is called.
 */
describe('the Cartographer and Planner dry runs from the built release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  const accountId = randomUUID();
  const universeId = randomUUID();

  beforeAll(async () => {
    database = await createEmptyDatabase('release_dry_run');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'dry-run-fixture', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
    await handle.db
      .insertInto('identity.universes')
      .values({ id: universeId, account_id: accountId, privacy_epoch: 1 })
      .execute();
  });
  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  async function dryRun(area: string, args: readonly string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), area, 'dry-run', ...args], {
      cwd: join(releaseDirectory(), 'worker'),
      env: { PATH: process.env['PATH'] ?? '', KS_WORLD: 'ci', DATABASE_URL: database.url, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { code, stdout, stderr };
  }
  const rowCount = async (table: string) =>
    (await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(handle.db)).rows[0]!.n;

  it('prints one line of counts and codes for a reader with nothing read, and writes nothing', async () => {
    const tables = ['geography.state', 'geography.runs', 'planner.state', 'planner.runs', 'reasoning.business_runs'];
    const before = await Promise.all(tables.map(rowCount));
    const geography = await dryRun('geography', ['--universe', universeId], { KS_CARTOGRAPHER_ENABLED: '1' });
    expect(geography.code).toBe(0);
    const lines = geography.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      command: 'geography dry-run',
      result: 'read',
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'no_support_yet' },
      wouldCallModel: false,
      due: { total: 0 },
    });
    const planner = await dryRun('planner', ['--universe', universeId], { KS_PLANNER_ENABLED: '1' });
    expect(planner.code).toBe(0);
    expect(JSON.parse(planner.stdout.trim())).toMatchObject({
      command: 'planner dry-run',
      result: 'read',
      outcome: 'insufficient_evidence',
      wouldCallModel: false,
      evidence: 0,
    });
    expect(await Promise.all(tables.map(rowCount))).toEqual(before);
    // Neither the universe nor the account is named in anything it prints.
    for (const text of [geography.stdout, geography.stderr, planner.stdout, planner.stderr]) {
      expect(text).not.toContain(universeId);
      expect(text).not.toContain(accountId);
    }
  });

  it('names a switched-off role as the real run would meet it', async () => {
    const result = await dryRun('geography', ['--universe', universeId]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      action: 'stops',
      roleEnabled: false,
      wouldRecord: { status: 'insufficient', outcome: 'disabled' },
    });
  });

  it('exits 2 for an unknown universe and a malformed call, and 1 for a configuration it cannot read', async () => {
    const unknown = await dryRun('planner', ['--universe', randomUUID()]);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout.trim())).toMatchObject({ result: 'refused', reason: 'universe_missing' });
    for (const args of [[], ['--universe'], ['--universe', 'not-a-uuid'], ['--universe', universeId, 'extra']]) {
      const refused = await dryRun('geography', args);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(JSON.parse(refused.stdout.trim())).toMatchObject({ result: 'usage' });
    }
    expect((await dryRun('geography', ['--universe', universeId], { DATABASE_URL: 'not-a-url' })).code).toBe(1);
  });
});
