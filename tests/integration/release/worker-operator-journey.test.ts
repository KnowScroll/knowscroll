import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { releaseDirectory, startReleaseProcess } from '../support/processes.js';

/**
 * The worker's operator command through the deployed release tree (S2.2 #231, review m6): how an
 * operator lists the attempts awaiting reconciliation, writes one off, sweeps what a crash left
 * `dispatched`, and what the command refuses. It is the only way to resolve an `unknown` attempt,
 * so it runs from the built `worker/` tree exactly as it does on a server.
 *
 * Evidence label: CI fixture + real database. The attempts are rows seeded for the journey; no
 * provider is called and no key exists.
 */
describe('the worker operator command (reasoning) from the built release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  const universeId = randomUUID();
  const runId = randomUUID();
  const outputs: string[] = [];
  const ids = { unknown: randomUUID(), dispatchedOld: randomUUID(), dispatchedRecent: randomUUID() };

  beforeAll(async () => {
    database = await createEmptyDatabase('release_reasoning_operator');
    const migrate = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await migrate.exited()).toBe(0);
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'knowscroll-it-fixtures', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    const accountId = randomUUID();
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
        purpose: 'operator-journey',
        privacy_epoch: 1,
        role_id: 'fixture.journey',
        role_version: 'v1',
        policy_version: 'fixture.v1',
        provider: 'minimax',
        model: 'MiniMax-M3',
        context_bundle_ref: 'fixture.bundle:journey',
        context_refs: JSON.stringify(['fixture:item-1']),
      })
      .execute();
    const seed = async (id: string, step: string, state: 'unknown' | 'dispatched', age: string, outcome?: string) => {
      await handle.db
        .insertInto('reasoning.external_attempts')
        .values({
          universe_id: universeId,
          id,
          run_id: runId,
          step,
          provider: 'minimax',
          model: 'MiniMax-M3',
          request_hash: 'a'.repeat(64),
          state,
          ...(outcome === undefined ? {} : { outcome_code: outcome }),
          dispatch_id: randomUUID(),
          dispatched_by: 'worker:1',
          dispatched_at: sql<Date>`now() - ${age}::interval`,
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
          attempt_id: id,
          role_id: 'fixture.journey',
          role_version: 'v1',
          provider: 'minimax',
          model: 'MiniMax-M3',
          budget_window: sql<Date>`(now() at time zone 'UTC')::date`,
          reserved_tokens: 1_000,
          state: state === 'unknown' ? 'unknown' : 'held',
        })
        .execute();
    };
    await seed(ids.unknown, 'primary', 'unknown', '2 hours', 'TIMEOUT_AFTER_DISPATCH');
    await seed(ids.dispatchedOld, 'repair', 'dispatched', '1 hour');
    await seed(ids.dispatchedRecent, 'primary.2', 'dispatched', '1 second');
  });
  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  /** Runs the release's worker operator command with a clean environment; stdout and stderr apart. */
  async function operator(env: Record<string, string>, args: readonly string[]) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), ...args], {
      cwd: join(releaseDirectory(), 'worker'),
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    outputs.push(stdout, stderr);
    const lines = stdout.split('\n').filter((line) => line !== '');
    const records = stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { event: string; problems?: string[]; reasonCode?: string });
    return {
      code,
      stdout,
      records,
      // Every command answers with exactly one JSON line on stdout.
      result: lines.length === 1 ? (JSON.parse(lines[0] ?? '{}') as Record<string, unknown>) : undefined,
    };
  }
  const env = () => ({ KS_WORLD: 'ci', DATABASE_URL: database.url });
  const row = (id: string) =>
    handle.db
      .selectFrom('reasoning.external_attempts')
      .select(['state', 'outcome_code', 'written_off_reason', 'written_off_by', 'settled_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const receipt = (id: string) =>
    handle.db
      .selectFrom('reasoning.usage_receipts')
      .select('state')
      .where('attempt_id', '=', id)
      .executeTakeFirstOrThrow();

  it('answers a usage line and exit 2 for no command, an unknown command or missing options', async () => {
    for (const args of [
      [],
      ['reasoning'],
      ['reasoning', 'frobnicate'],
      ['other', 'unknown'],
      ['reasoning', 'write-off'],
    ]) {
      const refused = await operator(env(), args);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.result).toMatchObject({ result: 'usage' });
    }
  });

  it('accepts all closed Scroll recipe keys for a dry run and refuses unknown keys before provider work', async () => {
    for (const topic of [
      'seasons',
      'tides',
      'greenhouse',
      'greenhouse-radiation',
      'greenhouse-balance',
      'greenhouse-limits',
      'attention-mechanism',
      'dns-lookup',
      'exoplanet-kinds',
    ]) {
      const result = await operator(env(), ['content', 'produce-scroll', '--topic', topic, '--dry-run']);
      expect(result.code).toBe(0);
      // A v2 library recipe adds the answer check to its two writer requests (D-198): six, not two.
      // `exoplanet-kinds` is the one recipe the plan has not marked (D-217): a v1 recipe stays at two.
      const requestBound = topic === 'exoplanet-kinds' ? 2 : 6;
      expect(result.result).toEqual({ command: 'content produce-scroll', outcome: 'dry_run', requestBound });
    }
    for (const topic of ['greenhouse-unknown', '__proto__', 'greenhouse ']) {
      const refused = await operator(env(), ['content', 'produce-scroll', '--topic', topic, '--dry-run']);
      expect(refused.code).toBe(2);
      expect(refused.result).toEqual({ result: 'topic_refused', requestBound: 2 });
    }
    expect(await handle.db.selectFrom('content.scroll_production_runs').select('id').execute()).toHaveLength(0);
    expect(await handle.db.selectFrom('reasoning.production_attempts').select('id').execute()).toHaveLength(0);
  });

  it('reports what readmit-coverage would do on a database without generated Scrolls, and writes nothing', async () => {
    const result = await operator(env(), ['content', 'readmit-coverage', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.result).toEqual({
      command: 'content readmit-coverage',
      dryRun: true,
      considered: 0,
      appended: 0,
      unchanged: 0,
      skipped: {},
    });
  });

  it('reports what admit-continuity would do on a database without library Scrolls, and writes nothing', async () => {
    const result = await operator(env(), ['content', 'admit-continuity', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.result).toMatchObject({
      command: 'content admit-continuity',
      dryRun: true,
      seriesRevisionsAdmitted: 0,
      seriesUnchanged: 0,
      linksAdmitted: 0,
      linksUnchanged: 0,
    });
    // Nothing is published, so every declared series is skipped and says what it waits for.
    const { seriesSkipped } = result.result as { seriesSkipped: { unpublished: string[] }[] };
    expect(seriesSkipped.length).toBeGreaterThan(0);
    expect(seriesSkipped.every((entry) => entry.unpublished.length > 0)).toBe(true);
    expect(await handle.db.selectFrom('content.continuity_links').select('id').execute()).toHaveLength(0);
  });

  it('refuses to start without its configuration, naming the variable and echoing no value', async () => {
    const missing = await operator({ KS_WORLD: 'ci' }, ['reasoning', 'unknown']);
    expect({ code: missing.code, stdout: missing.stdout }).toEqual({ code: 1, stdout: '' });
    expect(missing.records.find((record) => record.event === 'config.invalid')?.problems).toEqual([
      'DATABASE_URL: missing_or_wrong_type',
    ]);
    const malformed = await operator({ KS_WORLD: 'ci', DATABASE_URL: 'not-a-url-canary-password-77' }, [
      'reasoning',
      'unknown',
    ]);
    expect({ code: malformed.code, stdout: malformed.stdout }).toEqual({ code: 1, stdout: '' });
    expect(malformed.records.some((record) => record.event === 'config.invalid')).toBe(true);
    expect(`${malformed.stdout}${JSON.stringify(malformed.records)}`).not.toContain('canary-password-77');
  });

  it('lists the attempts awaiting reconciliation: identifiers and codes only', async () => {
    const listed = await operator(env(), ['reasoning', 'unknown']);
    expect(listed.code).toBe(0);
    const attempts = (listed.result?.['attempts'] ?? []) as Record<string, unknown>[];
    expect(attempts.map((attempt) => attempt['attemptId'])).toEqual([ids.unknown]);
    expect(Object.keys(attempts[0] ?? {}).sort()).toEqual(
      ['attemptId', 'dispatchedAt', 'model', 'outcomeCode', 'provider', 'roleId'].sort(),
    );
    expect((await operator(env(), ['reasoning', 'unknown', '--limit', '0'])).code).toBe(2);
    expect((await operator(env(), ['reasoning', 'unknown', '--limit', 'many'])).code).toBe(2);
  });

  it('refuses a malformed write-off before touching the ledger', async () => {
    for (const args of [
      ['reasoning', 'write-off', '--attempt', 'not-a-uuid', '--reason', 'x'],
      ['reasoning', 'write-off', '--attempt', ids.unknown, '--reason', '   '],
    ]) {
      const refused = await operator(env(), args);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.result).toMatchObject({ result: 'invalid_request' });
    }
    expect(await row(ids.unknown)).toMatchObject({ state: 'unknown', written_off_reason: null });
    const unknownAttempt = await operator(env(), [
      'reasoning',
      'write-off',
      '--attempt',
      randomUUID(),
      '--reason',
      'no such attempt',
    ]);
    expect(unknownAttempt.code).toBe(2);
    expect(unknownAttempt.result).toMatchObject({ result: 'missing' });
  });

  it('writes an unknown attempt off with the reason and the operator, and refuses a second write-off', async () => {
    const written = await operator(env(), [
      'reasoning',
      'write-off',
      '--attempt',
      ids.unknown,
      '--reason',
      'Journey: the provider outcome cannot be looked up; accepted as unresolved',
    ]);
    expect(written.code).toBe(0);
    expect(written.result).toMatchObject({
      command: 'reasoning write-off',
      result: 'written_off',
      attemptId: ids.unknown,
    });
    expect(await row(ids.unknown)).toMatchObject({
      state: 'written_off',
      outcome_code: 'TIMEOUT_AFTER_DISPATCH',
      written_off_reason: 'Journey: the provider outcome cannot be looked up; accepted as unresolved',
      written_off_by: expect.stringMatching(/^cli:[a-z_][a-z0-9_.-]{0,31}$/) as unknown,
      settled_at: expect.any(Date) as unknown,
    });
    expect(await receipt(ids.unknown)).toEqual({ state: 'written_off' });
    // Written off: no longer listed, and a second write-off changes nothing.
    expect((await operator(env(), ['reasoning', 'unknown'])).result?.['attempts']).toEqual([]);
    const again = await operator(env(), ['reasoning', 'write-off', '--attempt', ids.unknown, '--reason', 'second try']);
    expect(again.code).toBe(2);
    expect(again.result).toMatchObject({ result: 'not_unknown', state: 'written_off' });
    expect((await row(ids.unknown)).written_off_reason).toBe(
      'Journey: the provider outcome cannot be looked up; accepted as unresolved',
    );
  });

  it('refuses to write off a dispatched attempt, until the sweep moves it to unknown', async () => {
    const early = await operator(env(), [
      'reasoning',
      'write-off',
      '--attempt',
      ids.dispatchedOld,
      '--reason',
      'too early',
    ]);
    expect(early.code).toBe(2);
    expect(early.result).toMatchObject({ result: 'not_unknown', state: 'dispatched' });

    expect((await operator(env(), ['reasoning', 'sweep-dispatched', '--older-than-seconds', '-1'])).code).toBe(2);
    const swept = await operator(env(), ['reasoning', 'sweep-dispatched', '--older-than-seconds', '600']);
    expect(swept.code).toBe(0);
    expect(swept.result).toMatchObject({ command: 'reasoning sweep-dispatched', result: 'swept', count: 1 });
    // The hour-old attempt became unknown; the one dispatched a second ago is still in flight.
    expect(await row(ids.dispatchedOld)).toMatchObject({ state: 'unknown', outcome_code: 'OUTCOME_NOT_RECORDED' });
    expect(await receipt(ids.dispatchedOld)).toEqual({ state: 'unknown' });
    expect((await row(ids.dispatchedRecent)).state).toBe('dispatched');

    const listed = await operator(env(), ['reasoning', 'unknown']);
    expect(
      ((listed.result?.['attempts'] ?? []) as { attemptId: string }[]).map((attempt) => attempt.attemptId),
    ).toEqual([ids.dispatchedOld]);
    const written = await operator(env(), [
      'reasoning',
      'write-off',
      '--attempt',
      ids.dispatchedOld,
      '--reason',
      'Journey: crash after dispatch',
    ]);
    expect(written.code).toBe(0);
    expect((await row(ids.dispatchedOld)).state).toBe('written_off');
  });

  it('purges expired protected requests on demand and reports how many', async () => {
    const purged = await operator(env(), ['reasoning', 'purge-expired']);
    expect(purged.code).toBe(0);
    expect(purged.result).toMatchObject({ command: 'reasoning purge-expired', result: 'purged', count: 0 });
  });

  it('never prints the database URL', () => {
    for (const output of outputs) expect(output).not.toContain(database.url);
  });
});
