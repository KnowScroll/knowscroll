import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { releaseDirectory, startReleaseProcess } from '../support/processes.js';

/**
 * `operator.js journey` from the built worker tree (#248, D-044): one record's timeline, from a
 * server shell. Evidence label: CI fixture rows in a real database; no provider is called.
 */
describe('the journey inspector from the built release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  const accountId = randomUUID();
  const universeId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const privateContext = 'CI-PRIVATE-CONTEXT-REFERENCE';

  beforeAll(async () => {
    database = await createEmptyDatabase('release_journey');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'journey-fixture', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
    await handle.db
      .insertInto('identity.universes')
      .values({ id: universeId, account_id: accountId, privacy_epoch: 1 })
      .execute();
    await handle.db
      .insertInto('reasoning.business_runs')
      .values({
        universe_id: universeId,
        id: runId,
        owner_module: 'fixture',
        purpose: 'journey-fixture',
        privacy_epoch: 1,
        role_id: 'fixture.journey',
        role_version: 'v1',
        policy_version: 'fixture.v1',
        provider: 'minimax',
        model: 'MiniMax-M3',
        context_bundle_ref: 'fixture.bundle:journey',
        context_refs: JSON.stringify([privateContext]),
      })
      .execute();
    await handle.db
      .insertInto('reasoning.external_attempts')
      .values({
        universe_id: universeId,
        id: attemptId,
        run_id: runId,
        step: 'primary',
        provider: 'minimax',
        model: 'MiniMax-M3',
        request_hash: 'a'.repeat(64),
        state: 'unknown',
        outcome_code: 'TIMEOUT_AFTER_DISPATCH',
        dispatch_id: randomUUID(),
        dispatched_by: 'worker:1',
        dispatched_at: sql<Date>`now() - interval '2 hours'`,
        reserved_at: sql<Date>`now() - interval '2 hours'`,
        role_id: 'fixture.journey',
        role_version: 'v1',
        prompt_version: 'hp2',
        reserved_tokens: 1_000,
        budget_window: sql<Date>`(now() at time zone 'UTC')::date`,
      })
      .execute();
    await handle.db
      .insertInto('reasoning.usage_receipts')
      .values({
        attempt_id: attemptId,
        role_id: 'fixture.journey',
        role_version: 'v1',
        provider: 'minimax',
        model: 'MiniMax-M3',
        budget_window: sql<Date>`(now() at time zone 'UTC')::date`,
        reserved_tokens: 1_000,
        state: 'unknown',
      })
      .execute();
  });
  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  async function journey(args: readonly string[]) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), 'journey', ...args], {
      cwd: join(releaseDirectory(), 'worker'),
      env: { PATH: process.env['PATH'] ?? '', KS_WORLD: 'ci', DATABASE_URL: database.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { code, stdout, stderr };
  }

  it('prints the timeline of a reasoning run with the gap its unknown attempt leaves', async () => {
    const result = await journey([runId]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(new RegExp(`^journey run ${runId} \\(2 steps, from \\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(lines.some((line) => line.includes('reasoning.run') && line.includes('personal'))).toBe(true);
    expect(
      lines.some((line) => line.includes('reasoning.attempt') && line.includes('unknown TIMEOUT_AFTER_DISPATCH')),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('gap  reasoning.attempt') && line.includes('never sent again'))).toBe(
      true,
    );
    expect(result.stdout).not.toContain(privateContext);
    expect(result.stderr).not.toContain(privateContext);
  });

  it("starts from an account's universe when given the account", async () => {
    const result = await journey(['--account', accountId]);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')[0]).toContain(`journey universe ${universeId}`);
    const records = result.stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { event: string; route?: string; outcome?: string });
    expect(records).toContainEqual(
      expect.objectContaining({ event: 'operator.read', route: '/cli/journey', outcome: 'found' }),
    );
  });

  it('prints one JSON line with --json', async () => {
    const result = await journey([attemptId, '--json']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      command: 'journey',
      result: 'found',
      journey: { subject: 'attempt', subjectId: attemptId },
    });
  });

  it('exits 2 for an ID nothing carries, an unknown account and a malformed call', async () => {
    expect((await journey([randomUUID()])).code).toBe(2);
    expect((await journey(['--account', randomUUID()])).code).toBe(2);
    for (const args of [[], ['not-a-uuid'], [runId, attemptId], ['--account'], ['--account', accountId, runId]]) {
      const refused = await journey(args);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(JSON.parse(refused.stdout.trim())).toMatchObject({ result: 'usage' });
    }
  });
});
