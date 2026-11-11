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
 * (`KS_REASONING_PROVIDER=none`), so formation and the Planner take their rules-only paths. Passing proves the
 * canary runs end to end against the release and is green on a healthy fixture; it says nothing about dev content.
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
    return {
      code,
      stdout,
      stderr,
      result: lines.length === 1 ? (JSON.parse(lines[0] ?? '{}') as Record<string, unknown>) : undefined,
    };
  }
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
    expect(await handle.db.selectFrom('identity.accounts').select('id').execute()).toHaveLength(0);
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
        violations: unknown[];
        cleanup: { kept: boolean; requested: number; completed: number };
      };
      expect(summary).toMatchObject({
        result: 'passed',
        world: 'ci',
        pacing: 'wall_clock',
        speed: 'max',
        violations: [],
      });
      expect(summary.personas.map((persona) => persona.persona)).toEqual(['cold-start', 'deep-reader']);
      for (const persona of summary.personas) {
        // The starter Scroll was read for real, reported and qualified by the installed worker's projection.
        expect(persona.qualified).toBeGreaterThanOrEqual(1);
        expect(persona.observations.accepted).toBeGreaterThan(0);
        expect(persona.observations.rejected).toBe(0);
      }
      expect(summary.checks.length).toBeGreaterThan(10);
      expect(summary.checks.every((check) => check.status === 'ok')).toBe(true);
      expect(summary.cleanup).toEqual({ kept: false, requested: 2, completed: 2 });

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

  it('never prints the database URL', () => {
    for (const output of outputs) expect(output).not.toContain(database.url);
  });
});
