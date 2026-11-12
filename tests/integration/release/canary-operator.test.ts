import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import {
  freePort,
  releaseDirectory,
  startReleaseProcess,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';

/**
 * The post-deploy canary (#674, D-413) through the deployed release trees: the worker's `canary run` command mints
 * disposable accounts, signs them in through the real HTTP route of the installed API, reads a Scroll as two
 * personas in real time, reports the observations in the recorder's wire shapes, waits for the installed worker to
 * project them, judges its invariants from public routes and read-only operator views, and deletes the accounts
 * through the real account deletion flow.
 *
 * Evidence label: CI fixture + real database. The library is the one authored starter Scroll; no provider is called
 * (`KS_REASONING_PROVIDER=none`), so formation and the Planner take their rules-only paths and the Planner stays
 * parked. Passing proves the canary runs end to end against the release, that a signal or a kill is followed by the
 * deletion of its accounts, and that it says plainly which invariants this fixture never exercised; it says nothing
 * about dev content.
 */
const pattern = '*@test.knowscroll.space';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('the canary operator command from the built release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let worker: ReleaseProcess;
  let origin: string;
  const outputs: string[] = [];

  /** Runs the worker tree's operator command with a clean environment; stdout and stderr apart. */
  async function operator(tree: 'api' | 'worker', env: Record<string, string>, args: readonly string[]) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), ...args], {
      cwd: join(releaseDirectory(), tree),
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
    return { code, stdout, stderr, result: oneJsonLine(lines) };
  }
  /** The result of a command that prints exactly one JSON line; `undefined` for any other output (a sign-in link, say). */
  function oneJsonLine(lines: readonly string[]): Record<string, unknown> | undefined {
    if (lines.length !== 1) return undefined;
    try {
      return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  /** Starts the worker tree's operator command and hands back its streams, to be signalled while it runs. */
  function spawnCanary(env: Record<string, string>, args: readonly string[]) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), 'canary', ...args], {
      cwd: join(releaseDirectory(), 'worker'),
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve)).then((code) => {
      outputs.push(stdout, stderr);
      return code;
    });
    return {
      child,
      exited,
      stdout: () => stdout,
      stderr: () => stderr,
      /** The one JSON line on stdout. */
      result: () => {
        const lines = stdout.split('\n').filter((line) => line !== '');
        expect(lines).toHaveLength(1);
        return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      },
    };
  }
  /** Waits, within a bound, for a database condition: a canary reader has opened a Scroll, say. */
  async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const exposures = async () => (await handle.db.selectFrom('experience.exposures').select('id').execute()).length;
  const accounts = async () => (await handle.db.selectFrom('identity.accounts').select('id').execute()).length;
  const canaryEnv = () => ({
    KS_WORLD: 'ci',
    DATABASE_URL: database.url,
    KS_PUBLIC_ORIGIN: origin,
    KS_ALLOW_OPERATOR_SIGN_IN: '1',
    KS_OPERATOR_SIGN_IN_PATTERN: pattern,
  });

  beforeAll(async () => {
    database = await createEmptyDatabase('release_canary');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'knowscroll-it-fixtures', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    // The library of the fixture world: the authored starter Scroll the release tree carries.
    const starter = join(
      releaseDirectory(),
      'api',
      'node_modules',
      '@knowscroll',
      'backend',
      'dist',
      'modules',
      'content',
      'starter',
      'why-the-sky-is-blue.editorial-scroll.json',
    );
    const imported = await operator('api', { KS_WORLD: 'ci', DATABASE_URL: database.url }, [
      'content',
      'import-editorial',
      '--file',
      starter,
    ]);
    expect(imported.code).toBe(0);
    const shared = {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_REASONING_PROVIDER: 'none',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    };
    api = startReleaseProcess('api', 'main', {
      ...shared,
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_ALLOW_OPERATOR_SIGN_IN: '1',
      KS_OPERATOR_SIGN_IN_PATTERN: pattern,
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
    });
    worker = startReleaseProcess('worker', 'main', shared);
    await Promise.all([api.waitForEvent('process.started'), worker.waitForEvent('process.started')]);
    await waitForHttp(`${origin}/health`);
  });

  afterAll(async () => {
    try {
      if (worker) expect(await worker.stop()).toBe(0);
      if (api) expect(await api.stop()).toBe(0);
    } finally {
      await handle?.close();
      await database?.drop();
    }
  });

  it('refuses before touching anything: bad usage, a world that allows no operator tools, another host', async () => {
    for (const args of [
      [],
      ['run', '--personas', 'nobody'],
      ['run', '--speed', '61'],
      ['run', '--many', '0'],
      ['walk'],
    ]) {
      const refused = await operator('worker', canaryEnv(), ['canary', ...args]);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.result).toMatchObject({ result: 'usage' });
    }
    for (const world of ['live', 'production', 'prod']) {
      const refused = await operator('worker', { ...canaryEnv(), KS_WORLD: world }, ['canary', 'run']);
      expect(refused.code, world).toBe(2);
      expect(refused.result).toEqual({ command: 'canary run', result: 'refused', reasonCode: 'config_refused' });
    }
    const withoutSwitch = await operator('worker', { ...canaryEnv(), KS_ALLOW_OPERATOR_SIGN_IN: '0' }, [
      'canary',
      'run',
    ]);
    expect(withoutSwitch.code).toBe(2);
    const elsewhere = await operator('worker', canaryEnv(), ['canary', 'run', '--base-url', 'https://example.invalid']);
    expect(elsewhere.code).toBe(2);
    expect(elsewhere.result).toEqual({ command: 'canary run', result: 'refused', reasonCode: 'base_url_not_allowed' });
    const noWildcard = await operator(
      'worker',
      { ...canaryEnv(), KS_OPERATOR_SIGN_IN_PATTERN: 'fixed@test.knowscroll.space' },
      ['canary', 'run'],
    );
    expect(noWildcard.code).toBe(2);
    expect(noWildcard.result).toEqual({
      command: 'canary run',
      result: 'refused',
      reasonCode: 'pattern_has_no_wildcard',
    });
    // Stage needs its own flag; the options of one subcommand are refused on the other.
    const stage = await operator('worker', { ...canaryEnv(), KS_WORLD: 'stage' }, ['canary', 'run']);
    expect(stage.code).toBe(2);
    expect(stage.result).toEqual({
      command: 'canary run',
      result: 'refused',
      reasonCode: 'stage_requires_allow_stage',
    });
    for (const args of [
      ['cleanup', '--keep'],
      ['cleanup', '--speed', 'max'],
      ['cleanup', '--run', 'not-a-run'],
      ['run', '--dry-run'],
      ['run', '--run', 'ab12cd34'],
      ['run', '--timeout', '0'],
    ]) {
      const refused = await operator('worker', canaryEnv(), ['canary', ...args]);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.result, args.join(' ')).toMatchObject({ result: 'usage' });
    }
    expect(await handle.db.selectFrom('identity.accounts').select('id').execute()).toHaveLength(0);
  });

  it('still prints one JSON line saying it failed, with a code, when something breaks', async () => {
    const url = new URL(database.url);
    url.pathname = '/ks_it_canary_database_that_does_not_exist';
    const crashed = await operator('worker', { ...canaryEnv(), DATABASE_URL: url.toString() }, [
      'canary',
      'run',
      '--personas',
      'cold-start',
    ]);
    expect(crashed.code).toBe(1);
    expect(crashed.result).toEqual({ command: 'canary run', result: 'failed', reasonCode: 'crashed' });
    expect(crashed.stdout).not.toContain(url.toString());
  });

  it(
    'runs cold-start and deep-reader at the quickest honest pace: green, then every account is deleted',
    { timeout: 420_000 },
    async () => {
      const ran = await operator('worker', canaryEnv(), [
        'canary',
        'run',
        '--personas',
        'cold-start,deep-reader',
        '--speed',
        'max',
        '--wait',
        '60',
      ]);
      expect(ran.code, ran.stdout + ran.stderr).toBe(0);
      const summary = ran.result as {
        result: string;
        world: string;
        pacing: string;
        speed: string;
        personas: { persona: string; qualified: number; observations: { accepted: number; rejected: number } }[];
        checks: { code: string; status: string }[];
        notExercised: string[];
        spend: unknown;
        violations: unknown[];
        cleanup: { kept: boolean; requested: number; completed: number };
      };
      expect(summary).toMatchObject({
        result: 'passed',
        world: 'ci',
        pacing: 'wall_clock',
        speed: 'max',
        violations: [],
        strict: false,
      });
      expect(summary.personas.map((persona) => persona.persona)).toEqual(['cold-start', 'deep-reader']);
      for (const persona of summary.personas) {
        // The starter Scroll was read for real, reported and qualified by the installed worker's projection.
        expect(persona.qualified).toBeGreaterThanOrEqual(1);
        expect(persona.observations.accepted).toBeGreaterThan(0);
        expect(persona.observations.rejected).toBe(0);
      }
      // What the fixture exercised, and what it did not: the starter Scroll has no series, no Reel and no Planner
      // that is switched on, so those say so instead of being called ok.
      const statuses = Object.fromEntries(summary.checks.map((check) => [check.code, check.status]));
      expect(statuses).toEqual({
        first_offer_missing: 'ok',
        repeat_while_unseen_exists: 'ok',
        exhausted_while_unseen_exists: 'ok',
        reel_never_offered: 'not_exercised',
        reading_not_stored: 'ok',
        reading_not_projected: 'ok',
        reading_not_qualified: 'ok',
        formation_system_missing: 'not_exercised',
        formation_planet_missing: 'not_exercised',
        reel_media_unreachable: 'not_exercised',
        api_refused: 'ok',
        operator_reads_failed: 'ok',
        job_failed: 'ok',
        job_dead_lettered: 'ok',
        shared_supply_touched: 'ok',
        planner_run_unknown: 'not_exercised',
        planner_run_stuck: 'not_exercised',
        geography_run_stuck: 'ok',
        cleanup_incomplete: 'ok',
      });
      expect(summary.notExercised.sort()).toEqual(
        Object.keys(statuses)
          .filter((code) => statuses[code] === 'not_exercised')
          .sort(),
      );
      // The run asked nothing of shared supply, and no model was called.
      expect(summary.spend).toEqual({ supplyRequests: 0, commissionedWork: 0, modelAttempts: {} });
      expect(summary.cleanup).toEqual({ kept: false, requested: 2, completed: 2 });
      // The run id went to stderr, at the start, as a diagnostic record.
      expect(ran.stderr).toMatch(/"event":"operator\.canary_started"[^\n]*"canaryRun":"[0-9a-f]{8}"/);

      // Counts and codes only: no id, address or link reaches stdout, and no sign-in credential reaches stderr.
      expect(ran.stdout).not.toMatch(UUID);
      expect(ran.stdout).not.toContain('canary-');
      expect(ran.stdout).not.toContain('test.knowscroll.space');
      expect(ran.stdout + ran.stderr).not.toMatch(/ksl_[A-Za-z0-9_-]{20}|kss_[A-Za-z0-9_-]{20}/);

      // The accounts are gone through the real deletion flow; only the audit rows of the mints remain.
      expect(await handle.db.selectFrom('identity.accounts').select('id').execute()).toHaveLength(0);
      expect(await handle.db.selectFrom('identity.universes').select('id').execute()).toHaveLength(0);
      expect(await handle.db.selectFrom('identity.email_addresses').select('address').execute()).toHaveLength(0);
      const audit = await handle.db.selectFrom('ops.operator_sign_ins').select('account_id').execute();
      expect(audit).toHaveLength(2);
      expect(audit.every((row) => row.account_id === null)).toBe(true);
      expect(await handle.db.selectFrom('evidence.observations').select('id').execute()).toHaveLength(0);
    },
  );

  it(
    'fails a --strict run that never exercised some invariants, though it broke none',
    { timeout: 300_000 },
    async () => {
      const ran = await operator('worker', canaryEnv(), [
        'canary',
        'run',
        '--personas',
        'cold-start',
        '--speed',
        'max',
        '--wait',
        '5',
        '--strict',
      ]);
      expect(ran.code).toBe(1);
      expect(ran.result).toMatchObject({
        command: 'canary run',
        result: 'failed',
        reasonCode: 'strict_unfinished',
        strict: true,
        violations: [],
        cleanup: { kept: false, requested: 1, completed: 1 },
      });
      expect((ran.result?.['notExercised'] as string[]).length).toBeGreaterThan(0);
      expect(await accounts()).toBe(0);
    },
  );

  it(
    'stops at SIGTERM mid-reading: prints one aborted line and deletes its account',
    { timeout: 300_000 },
    async () => {
      const before = await exposures();
      const running = spawnCanary(canaryEnv(), ['run', '--personas', 'cold-start', '--speed', 'max']);
      await until('the reader to open a Scroll', async () => (await exposures()) > before);
      expect(await accounts()).toBe(1);
      running.child.kill('SIGTERM');
      expect(await running.exited).toBe(1);
      expect(running.result()).toMatchObject({
        command: 'canary run',
        result: 'aborted',
        reasonCode: 'sigterm',
        cleanup: { kept: false, requested: 1, completed: 1 },
      });
      expect(await accounts()).toBe(0);
      expect(running.stderr()).toMatch(/"event":"operator\.canary_stopped"[^\n]*"reasonCode":"sigterm"/);
    },
  );

  it(
    'leaves a kept, stopped run to `canary cleanup`, which finds only its own accounts and deletes them',
    { timeout: 300_000 },
    async () => {
      // A test account that is not the canary's: cleanup must never touch it.
      const bystander = await operator('api', canaryEnv(), [
        'issue-sign-in',
        '--email',
        'bystander@test.knowscroll.space',
      ]);
      expect(bystander.code).toBe(0);
      const before = await exposures();
      const running = spawnCanary(canaryEnv(), ['run', '--personas', 'cold-start', '--speed', 'max', '--keep']);
      await until('the reader to open a Scroll', async () => (await exposures()) > before);
      running.child.kill('SIGINT');
      expect(await running.exited).toBe(1);
      expect(running.result()).toMatchObject({ result: 'aborted', reasonCode: 'sigint', cleanup: { kept: true } });
      expect(await accounts()).toBe(2);
      const runId = /"event":"operator\.canary_started"[^\n]*"canaryRun":"([0-9a-f]{8})"/.exec(running.stderr())?.[1];
      expect(runId).toBeDefined();

      const dry = await operator('worker', canaryEnv(), ['canary', 'cleanup', '--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.result).toMatchObject({ result: 'dry_run', found: 1, runs: 1, deleted: 0 });
      expect(await accounts()).toBe(2);
      const otherRun = await operator('worker', canaryEnv(), ['canary', 'cleanup', '--run', '00000000']);
      expect(otherRun.result).toMatchObject({ result: 'done', found: 0, deleted: 0 });
      expect(await accounts()).toBe(2);

      const cleaned = await operator('worker', canaryEnv(), ['canary', 'cleanup', '--run', runId ?? '']);
      expect(cleaned.code, cleaned.stdout + cleaned.stderr).toBe(0);
      expect(cleaned.result).toMatchObject({ result: 'done', found: 1, runs: 1, deleted: 1, failed: 0 });
      expect(cleaned.stdout).not.toMatch(UUID);
      expect(cleaned.stdout).not.toContain('canary-');
      const left = await handle.db.selectFrom('identity.email_addresses').select('address').execute();
      expect(left.map((row) => row.address)).toEqual(['bystander@test.knowscroll.space']);
      expect(await accounts()).toBe(1);
    },
  );

  it('never prints the database URL', () => {
    for (const output of outputs) expect(output).not.toContain(database.url);
  });
});
