import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  readApiConfig,
  readMigrateConfig,
  readOperatorConfig,
  readWorkerConfig,
  readWorkerOperatorConfig,
  readReelOperatorConfig,
  readScrollProductionOperatorConfig,
} from './index.js';

const secretUrl = 'postgres://ks_api:hunter2-very-secret@127.0.0.1:5432/knowscroll_v2_dev';
const release = {
  KS_WORLD: 'dev',
  KS_COMMIT: '0123456789abcdef0123456789abcdef01234567',
  KS_ARTIFACT_SHA256: 'a'.repeat(64),
};
/** Fixture sign-in settings a deployed world provides (the key is a fixture, not a credential). */
const agentMail = {
  AGENTMAIL_API_KEY: 'fixture-agentmail-key-hunter2',
  AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
};
const production = { NODE_ENV: 'production', KS_PUBLIC_ORIGIN: 'https://app.dev.knowscroll.space', ...agentMail };

function configurationError(read: () => unknown): ConfigurationError {
  try {
    read();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error('expected a ConfigurationError');
}

describe('process configuration', () => {
  it('reads a complete production API configuration', () => {
    const config = readApiConfig({ ...production, DATABASE_URL: secretUrl, PORT: '4330', ...release });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      world: 'dev',
      commit: release.KS_COMMIT,
      artifactSha256: release.KS_ARTIFACT_SHA256,
      listen: { host: '127.0.0.1', port: 4330 },
      authAdapter: 'session',
      identity: {
        publicOrigin: 'https://app.dev.knowscroll.space',
        secureCookies: true,
        mail: { sender: 'agentmail', baseUrl: 'https://api.agentmail.to', timeoutMs: 10_000 },
        operatorSignIn: undefined,
        nativeSignInBinding: false,
      },
    });
    expect(config.database.applicationName).toBe('knowscroll-api-dev');
  });

  it('refuses production without release identity', () => {
    const error = configurationError(() => readApiConfig({ ...production, DATABASE_URL: secretUrl, PORT: '4330' }));
    expect(error.problems.map((problem) => problem.split(':')[0])).toEqual([
      'KS_WORLD',
      'KS_COMMIT',
      'KS_ARTIFACT_SHA256',
    ]);
  });

  it('runs the Planner by default only in the local world and keeps KS_PLANNER_ENABLED a switch', () => {
    expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' }).plannerEnabled).toBe(true);
    expect(
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_PLANNER_ENABLED: '0' }).plannerEnabled,
    ).toBe(false);
    for (const world of ['dev', 'stage', 'ci', 'live'])
      expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: world }).plannerEnabled).toBe(false);
    expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'dev', KS_PLANNER_ENABLED: '1' }).plannerEnabled).toBe(
      true,
    );
    expect(() =>
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_PLANNER_ENABLED: 'true' }),
    ).toThrow();
  });

  it('keeps Cartographer disabled and validates its separate feature flag', () => {
    expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' }).cartographerEnabled).toBe(false);
    expect(
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_CARTOGRAPHER_ENABLED: '1' })
        .cartographerEnabled,
    ).toBe(true);
    expect(() =>
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_CARTOGRAPHER_ENABLED: 'true' }),
    ).toThrow();
  });
  it('keeps Jev off until its switch is explicitly enabled', () => {
    expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' }).jevEnabled).toBe(false);
    expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_JEV_ENABLED: '1' }).jevEnabled).toBe(true);
    expect(() => readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_JEV_ENABLED: 'true' })).toThrow();
  });
  it('makes Composer decisions under v0 until the world says v1, in the API and the worker, and refuses any other value', () => {
    const worker = (env: Record<string, string>) =>
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', ...env });
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    expect(worker({}).composerPolicy).toBe('v0');
    expect(api({}).composerPolicy).toBe('v0');
    expect(worker({ KS_COMPOSER_POLICY: 'v1' }).composerPolicy).toBe('v1');
    expect(api({ KS_COMPOSER_POLICY: 'v1' }).composerPolicy).toBe('v1');
    expect(worker({ KS_COMPOSER_POLICY: 'v0' }).composerPolicy).toBe('v0');
    for (const value of ['v2', 'V1', '1', 'composer-policy.v1', ''])
      expect(() => worker({ KS_COMPOSER_POLICY: value })).toThrow();
    expect(() => api({ KS_COMPOSER_POLICY: 'v2' })).toThrow();
  });
  it('lets Create start productions by default only in the local world, bounded per day', () => {
    const worker = (env: Record<string, string>) => readWorkerConfig({ DATABASE_URL: secretUrl, ...env });
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    expect(worker({ KS_WORLD: 'local' }).supplyCreateDailyCap).toBe(20);
    expect(api({ KS_WORLD: 'local' }).supplyCreateDailyCap).toBe(20);
    for (const world of ['dev', 'stage', 'ci']) {
      expect(worker({ KS_WORLD: world }).supplyCreateDailyCap).toBe(0);
      expect(api({ KS_WORLD: world }).supplyCreateDailyCap).toBe(0);
    }
    expect(api({ KS_WORLD: 'dev', KS_SUPPLY_CREATE_DAILY_CAP: '8' }).supplyCreateDailyCap).toBe(8);
    expect(worker({ KS_WORLD: 'local', KS_SUPPLY_CREATE_DAILY_CAP: '0' }).supplyCreateDailyCap).toBe(0);
    expect(() => api({ KS_WORLD: 'local', KS_SUPPLY_CREATE_DAILY_CAP: '501' })).toThrow();
    expect(() => worker({ KS_WORLD: 'local', KS_SUPPLY_CREATE_DAILY_CAP: '-1' })).toThrow();
  });
  it('bounds scenario Create by its own daily cap, off outside local, and by a cap per thread per day', () => {
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    expect(api({ KS_WORLD: 'local' }).supplyScenarioDailyCap).toBe(20);
    for (const world of ['dev', 'stage', 'ci']) expect(api({ KS_WORLD: world }).supplyScenarioDailyCap).toBe(0);
    expect(api({ KS_WORLD: 'dev', KS_SUPPLY_SCENARIO_DAILY_CAP: '6' }).supplyScenarioDailyCap).toBe(6);
    // Five a day per thread (D-076): the old per-life variable is not read any more.
    expect(api({ KS_WORLD: 'dev' }).supplyScenarioThreadDailyCap).toBe(5);
    expect(api({ KS_WORLD: 'dev', KS_SUPPLY_SCENARIO_THREAD_CAP: '6' }).supplyScenarioThreadDailyCap).toBe(5);
    expect(api({ KS_WORLD: 'dev', KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP: '3' }).supplyScenarioThreadDailyCap).toBe(3);
    expect(() => api({ KS_WORLD: 'local', KS_SUPPLY_SCENARIO_DAILY_CAP: '501' })).toThrow();
    expect(() => api({ KS_WORLD: 'local', KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP: '0' })).toThrow();
  });
  it('bounds ask orders by their own daily cap for the world, off outside local, and by a cap for each person, in both processes (D-218)', () => {
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    const worker = (env: Record<string, string>) =>
      readWorkerConfig({ ...production, ...release, DATABASE_URL: secretUrl, ...env });
    for (const read of [api, worker]) {
      expect(read({ KS_WORLD: 'local' }).supplyAskDailyCap).toBe(20);
      for (const world of ['dev', 'stage', 'ci']) expect(read({ KS_WORLD: world }).supplyAskDailyCap).toBe(0);
      expect(read({ KS_WORLD: 'dev', KS_SUPPLY_ASK_DAILY_CAP: '8' }).supplyAskDailyCap).toBe(8);
      expect(read({ KS_WORLD: 'dev' }).supplyAskPersonDailyCap).toBe(5);
      expect(read({ KS_WORLD: 'dev', KS_SUPPLY_ASK_PERSON_DAILY_CAP: '3' }).supplyAskPersonDailyCap).toBe(3);
      expect(() => read({ KS_WORLD: 'local', KS_SUPPLY_ASK_DAILY_CAP: '501' })).toThrow();
      expect(() => read({ KS_WORLD: 'local', KS_SUPPLY_ASK_PERSON_DAILY_CAP: '0' })).toThrow();
    }
    // The other Create caps are not what turns ask orders on.
    expect(
      api({ KS_WORLD: 'dev', KS_SUPPLY_CREATE_DAILY_CAP: '8', KS_SUPPLY_SCENARIO_DAILY_CAP: '6' }).supplyAskDailyCap,
    ).toBe(0);
  });
  it('names the operator accounts from the list, or from the sign-in pattern on dev only', () => {
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    const signIn = { KS_ALLOW_OPERATOR_SIGN_IN: '1', KS_OPERATOR_SIGN_IN_PATTERN: '*@test.knowscroll.space' };
    expect(api({ KS_WORLD: 'dev' }).operatorAccounts).toEqual([]);
    expect(api({ KS_WORLD: 'dev', ...signIn }).operatorAccounts).toEqual(['*@test.knowscroll.space']);
    expect(api({ KS_WORLD: 'stage', ...signIn }).operatorAccounts).toEqual([]);
    expect(
      api({ KS_WORLD: 'stage', KS_OPERATOR_ACCOUNTS: 'owner@example.com, *@test.knowscroll.space' }).operatorAccounts,
    ).toEqual(['owner@example.com', '*@test.knowscroll.space']);
    expect(api({ KS_WORLD: 'dev', ...signIn, KS_OPERATOR_ACCOUNTS: 'owner@example.com' }).operatorAccounts).toEqual([
      'owner@example.com',
    ]);
  });
  it('refuses a malformed operator list, and a wildcard on the live world', () => {
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    expect(api({ KS_WORLD: 'live', KS_OPERATOR_ACCOUNTS: 'owner@example.com' }).operatorAccounts).toEqual([
      'owner@example.com',
    ]);
    expect(configurationError(() => api({ KS_WORLD: 'live', KS_OPERATOR_ACCOUNTS: '*@example.com' })).problems).toEqual(
      ['KS_OPERATOR_ACCOUNTS: wildcard_refused_in_this_world'],
    );
    for (const bad of ['Owner@Example.com', 'a*b*@example.com', 'not-an-address', 'owner@example.com,']) {
      expect(configurationError(() => api({ KS_WORLD: 'dev', KS_OPERATOR_ACCOUNTS: bad })).problems, bad).toEqual([
        'KS_OPERATOR_ACCOUNTS: invalid_format',
      ]);
    }
  });
  it('gives the Planner its own, smaller Create cap, five a day unless set', () => {
    const worker = (env: Record<string, string>) => readWorkerConfig({ DATABASE_URL: secretUrl, ...env });
    const api = (env: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', ...env });
    expect(api({ KS_WORLD: 'dev' }).supplyPlannerCreateDailyCap).toBe(5);
    expect(worker({ KS_WORLD: 'local' }).supplyPlannerCreateDailyCap).toBe(5);
    expect(worker({ KS_WORLD: 'dev', KS_SUPPLY_PLANNER_CREATE_DAILY_CAP: '2' }).supplyPlannerCreateDailyCap).toBe(2);
    expect(api({ KS_WORLD: 'local', KS_SUPPLY_PLANNER_CREATE_DAILY_CAP: '0' }).supplyPlannerCreateDailyCap).toBe(0);
    expect(() => api({ KS_WORLD: 'local', KS_SUPPLY_PLANNER_CREATE_DAILY_CAP: '501' })).toThrow();
    expect(() => worker({ KS_WORLD: 'local', KS_SUPPLY_PLANNER_CREATE_DAILY_CAP: '-1' })).toThrow();
  });
  it('gives the production scope its own, larger daily caps and leaves the person and global caps alone', () => {
    const caps = readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' }).reasoning.caps;
    expect(caps.productionScope).toEqual({ requestsPerDay: 200, tokensPerDay: 3_000_000 });
    expect(caps.scope).toEqual({ requestsPerDay: 60, tokensPerDay: 600_000 });
    expect(caps.global).toEqual({ requestsPerDay: 300, tokensPerDay: 3_000_000 });
    const raised = readWorkerConfig({
      DATABASE_URL: secretUrl,
      KS_WORLD: 'local',
      KS_REASONING_PRODUCTION_REQUESTS_PER_DAY: '400',
      KS_REASONING_PRODUCTION_TOKENS_PER_DAY: '6000000',
    }).reasoning.caps;
    expect(raised.productionScope).toEqual({ requestsPerDay: 400, tokensPerDay: 6_000_000 });
    expect(raised.scope).toEqual(caps.scope);
    expect(
      readScrollProductionOperatorConfig({
        DATABASE_URL: secretUrl,
        KS_WORLD: 'local',
        KS_REASONING_PRODUCTION_REQUESTS_PER_DAY: '150',
      }).reasoning.caps.productionScope.requestsPerDay,
    ).toBe(150);
    expect(() =>
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_REASONING_PRODUCTION_REQUESTS_PER_DAY: '0' }),
    ).toThrow();
  });
  it('keeps the residents’ feed off by default, apart from residents themselves (v3 R-8, D-248)', () => {
    const env = { DATABASE_URL: secretUrl, KS_WORLD: 'local' };
    expect(readWorkerConfig(env).reasoning.roomFeedEnabled).toBe(false);
    expect(readWorkerConfig({ ...env, KS_ROOMS_FEED_ENABLED: '1' }).reasoning).toMatchObject({
      roomFeedEnabled: true,
      roomEnabled: false,
    });
    expect(configurationError(() => readWorkerConfig({ ...env, KS_ROOMS_FEED_ENABLED: 'yes' })).problems).toEqual([
      'KS_ROOMS_FEED_ENABLED: not_allowed',
    ]);
  });
  it('keeps scouts off by default in both processes, and on their own switch (v3 R-9, D-259)', () => {
    const env = { DATABASE_URL: secretUrl, KS_WORLD: 'local' };
    expect(readWorkerConfig(env).reasoning.roomScoutsEnabled).toBe(false);
    expect(readWorkerConfig({ ...env, KS_ROOMS_SCOUTS_ENABLED: '1' }).reasoning).toMatchObject({
      roomScoutsEnabled: true,
      roomFeedEnabled: false,
    });
    expect(configurationError(() => readWorkerConfig({ ...env, KS_ROOMS_SCOUTS_ENABLED: 'yes' })).problems).toEqual([
      'KS_ROOMS_SCOUTS_ENABLED: not_allowed',
    ]);
    const api = (extra: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', KS_WORLD: 'local', ...extra });
    expect(api({}).roomScoutsEnabled).toBe(false);
    expect(api({ KS_ROOMS_SCOUTS_ENABLED: '1' }).roomScoutsEnabled).toBe(true);
  });
  it('keeps residents off by default, with caps of their own and an ambient share of the global cap (D-162)', () => {
    const env = { DATABASE_URL: secretUrl, KS_WORLD: 'local' };
    const settings = readWorkerConfig(env).reasoning;
    expect(settings).toMatchObject({ roomEnabled: false, roomGeneration: 1, ambientSharePercent: 30 });
    expect(settings.caps.roomScope).toEqual({ requestsPerDay: 100, tokensPerDay: 1_000_000 });
    const dev = readWorkerConfig({
      ...env,
      KS_REASONING_ROOM_ENABLED: '1',
      KS_REASONING_ROOM_REQUESTS_PER_DAY: '150',
      KS_REASONING_ROOM_TOKENS_PER_DAY: '1500000',
      KS_REASONING_AMBIENT_SHARE_PERCENT: '0',
    }).reasoning;
    expect(dev).toMatchObject({ roomEnabled: true, ambientSharePercent: 0 });
    expect(dev.caps.roomScope).toEqual({ requestsPerDay: 150, tokensPerDay: 1_500_000 });
    expect(configurationError(() => readWorkerConfig({ ...env, KS_REASONING_ROOM_ENABLED: 'true' })).problems).toEqual([
      'KS_REASONING_ROOM_ENABLED: not_allowed',
    ]);
    for (const bad of ['101', '-1', '12.5', 'lots'])
      expect(
        configurationError(() => readWorkerConfig({ ...env, KS_REASONING_AMBIENT_SHARE_PERCENT: bad })).problems,
      ).toHaveLength(1);
    // The API reads the same switch, so a world that leaves residents off queues no check for them.
    const api = (extra: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', KS_WORLD: 'local', ...extra });
    expect(api({}).roomResidentsEnabled).toBe(false);
    expect(api({ KS_REASONING_ROOM_ENABLED: '1' }).roomResidentsEnabled).toBe(true);
  });

  it('lets a world raise the stars a room earns in a day from three, within fifty', () => {
    const api = (extra: Record<string, string>) =>
      readApiConfig({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', KS_WORLD: 'local', ...extra });
    expect(api({}).roomStarsPerDay).toBe(3);
    expect(api({ KS_ROOMS_STARS_PER_DAY: '12' }).roomStarsPerDay).toBe(12);
    for (const bad of ['0', '51', '2.5', 'many'])
      expect(configurationError(() => api({ KS_ROOMS_STARS_PER_DAY: bad })).problems).toHaveLength(1);
    // The worker settles a finished Launch, so it reads the same cap (D-298).
    const worker = (extra: Record<string, string>) =>
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', ...extra });
    expect(worker({}).roomStarsPerDay).toBe(3);
    expect(worker({ KS_ROOMS_STARS_PER_DAY: '12' }).roomStarsPerDay).toBe(12);
    expect(configurationError(() => worker({ KS_ROOMS_STARS_PER_DAY: '51' })).problems).toHaveLength(1);
  });

  it('keeps half of every daily cap for roles a person asks for, and reads the share as whole percent', () => {
    const env = { DATABASE_URL: secretUrl, KS_WORLD: 'local' };
    expect(readWorkerConfig(env).reasoning.backgroundSharePercent).toBe(50);
    expect(
      readWorkerConfig({ ...env, KS_REASONING_BACKGROUND_SHARE_PERCENT: '0' }).reasoning.backgroundSharePercent,
    ).toBe(0);
    expect(
      readScrollProductionOperatorConfig({ ...env, KS_REASONING_BACKGROUND_SHARE_PERCENT: '100' }).reasoning
        .backgroundSharePercent,
    ).toBe(100);
    for (const bad of ['101', '-1', '12.5', 'half'])
      expect(
        configurationError(() => readWorkerConfig({ ...env, KS_REASONING_BACKGROUND_SHARE_PERCENT: bad })).problems,
      ).toHaveLength(1);
  });
  it('reads the production generation the Scroll consumer works under', () => {
    expect(readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' }).scrollProductionGeneration).toBe(1);
    expect(
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_SCROLL_PRODUCTION_GENERATION: '2' })
        .scrollProductionGeneration,
    ).toBe(2);
  });
  it('defaults the commit and artifact outside production, but never the world', () => {
    const config = readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' });
    expect(config).toMatchObject({
      nodeEnv: 'development',
      world: 'local',
      commit: 'unknown',
      artifactSha256: 'unknown',
    });
    for (const nodeEnv of [undefined, 'development', 'test']) {
      const env = {
        DATABASE_URL: secretUrl,
        PORT: '4330',
        ...agentMail,
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      };
      expect(configurationError(() => readWorkerConfig(env)).problems).toEqual(['KS_WORLD: missing_or_wrong_type']);
      expect(configurationError(() => readApiConfig(env)).problems).toEqual(['KS_WORLD: missing_or_wrong_type']);
    }
    // A missing world cannot enable the test-only caller adapter.
    expect(
      configurationError(() =>
        readApiConfig({
          NODE_ENV: 'test',
          DATABASE_URL: secretUrl,
          PORT: '4330',
          KS_AUTH_ADAPTER: 'test-bearer',
          KS_MAIL_SENDER: 'fixture',
        }),
      ).problems,
    ).toEqual(['KS_WORLD: missing_or_wrong_type', 'KS_MAIL_SENDER: refused_in_this_world']);
  });

  it('requires the world for the migration command too', () => {
    expect(configurationError(() => readMigrateConfig({ DATABASE_URL: secretUrl })).problems).toEqual([
      'KS_WORLD: missing_or_wrong_type',
    ]);
    const config = readMigrateConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'stage' });
    expect(config.world).toBe('stage');
    expect(config.database.applicationName).toBe('knowscroll-migrate-stage');
  });

  it('reports release identity and process problems together', () => {
    const error = configurationError(() =>
      readApiConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://x', PORT: 'not-a-port' }),
    );
    expect(error.problems.map((problem) => problem.split(':')[0])).toEqual([
      'KS_WORLD',
      'KS_COMMIT',
      'KS_ARTIFACT_SHA256',
      'DATABASE_URL',
      'PORT',
      'KS_PUBLIC_ORIGIN',
      'AGENTMAIL_API_KEY',
      'AGENTMAIL_INBOX_ID',
    ]);
    for (const problem of error.problems) expect(problem).toMatch(/^[A-Z][A-Z0-9_]*: [a-z_]+$/);
  });

  it('refuses the test-only caller adapter unless NODE_ENV=test in a ci or local world', () => {
    const problemsOf = (env: Record<string, string>) =>
      configurationError(() =>
        readApiConfig({ DATABASE_URL: secretUrl, PORT: '4330', KS_AUTH_ADAPTER: 'test-bearer', ...agentMail, ...env }),
      ).problems;
    expect(problemsOf({ ...production, ...release })).toContain('KS_AUTH_ADAPTER: refused_outside_test');
    expect(problemsOf({ NODE_ENV: 'development', KS_WORLD: 'local' })).toContain(
      'KS_AUTH_ADAPTER: refused_outside_test',
    );
    for (const world of ['dev', 'stage', 'live'])
      expect(problemsOf({ NODE_ENV: 'test', KS_WORLD: world })).toEqual(['KS_AUTH_ADAPTER: refused_in_this_world']);
    for (const world of ['ci', 'local']) {
      expect(
        readApiConfig({
          NODE_ENV: 'test',
          KS_WORLD: world,
          DATABASE_URL: secretUrl,
          PORT: '4330',
          KS_AUTH_ADAPTER: 'test-bearer',
          KS_MAIL_SENDER: 'fixture',
        }).authAdapter,
      ).toBe('test-bearer');
    }
  });

  it('requires the personal-scope lock wait to end before the statement timeout', () => {
    for (const read of [readApiConfig, readWorkerConfig]) {
      const error = configurationError(() =>
        read({
          KS_WORLD: 'local',
          DATABASE_URL: secretUrl,
          PORT: '4330',
          ...agentMail,
          KS_SCOPE_LOCK_TIMEOUT_MS: '20000',
          KS_DB_STATEMENT_TIMEOUT_MS: '15000',
        }),
      );
      expect(error.problems).toEqual(['KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout']);
    }
  });

  it('never echoes a value in its problems', () => {
    const error = configurationError(() =>
      readApiConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://root:hunter2-very-secret@db/x',
        PORT: 'hunter2-very-secret',
        KS_WORLD: 'Hunter2-Very-Secret',
        KS_COMMIT: 'hunter2-very-secret',
        KS_ARTIFACT_SHA256: 'x',
        KS_PUBLIC_ORIGIN: 'http://hunter2-very-secret.example',
        AGENTMAIL_API_KEY: 'hunter2-very-secret',
        AGENTMAIL_INBOX_ID: 'hunter2-very-secret',
        AGENTMAIL_BASE_URL: 'https://hunter2-very-secret.example',
        KS_ALLOW_OPERATOR_SIGN_IN: 'hunter2-very-secret',
      }),
    );
    expect(error.message).not.toContain('hunter2');
    expect(error.message.toLowerCase()).not.toContain('hunter2');
    expect(error.problems.length).toBeGreaterThan(0);
  });

  describe('sign-in settings (D-007, D-022)', () => {
    const local = { NODE_ENV: 'test', KS_WORLD: 'ci', DATABASE_URL: secretUrl, PORT: '4330' };
    const problemsOf = (env: Record<string, string>) => configurationError(() => readApiConfig(env)).problems;

    it('refuses to start in production without AgentMail fully configured', () => {
      const base = { ...release, NODE_ENV: 'production', DATABASE_URL: secretUrl, PORT: '4330' };
      const origin = { KS_PUBLIC_ORIGIN: 'https://app.dev.knowscroll.space' };
      expect(problemsOf({ ...base, ...origin })).toEqual([
        'AGENTMAIL_API_KEY: missing_or_wrong_type',
        'AGENTMAIL_INBOX_ID: missing_or_wrong_type',
      ]);
      expect(problemsOf({ ...base, ...origin, AGENTMAIL_API_KEY: agentMail.AGENTMAIL_API_KEY })).toEqual([
        'AGENTMAIL_INBOX_ID: missing_or_wrong_type',
      ]);
      expect(problemsOf({ ...base, ...origin, ...agentMail, AGENTMAIL_API_KEY: '' })).toEqual([
        'AGENTMAIL_API_KEY: out_of_range',
      ]);
      // No other base URL (a redirect of the key to another host) in production.
      expect(problemsOf({ ...base, ...origin, ...agentMail, AGENTMAIL_BASE_URL: 'http://127.0.0.1:9' })).toEqual([
        'AGENTMAIL_BASE_URL: refused_in_production',
      ]);
    });

    it('refuses the fixture mail sender outside NODE_ENV=test in a ci or local world', () => {
      expect(
        problemsOf({ ...production, ...release, DATABASE_URL: secretUrl, PORT: '4330', KS_MAIL_SENDER: 'fixture' }),
      ).toEqual(['KS_MAIL_SENDER: refused_outside_test']);
      for (const world of ['dev', 'stage', 'live'])
        expect(problemsOf({ ...local, KS_WORLD: world, KS_MAIL_SENDER: 'fixture' })).toEqual([
          'KS_MAIL_SENDER: refused_in_this_world',
        ]);
      expect(problemsOf({ ...local, KS_MAIL_SENDER: 'file' })).toEqual(['KS_MAIL_SENDER: not_allowed']);
      expect(
        readApiConfig({ ...local, KS_MAIL_SENDER: 'fixture', KS_FIXTURE_MAIL_FILE: '/tmp/outbox' }).identity.mail,
      ).toEqual({ sender: 'fixture', outboxFile: '/tmp/outbox' });
    });

    it('requires an HTTPS public origin in production, except on a loopback host', () => {
      const base = { ...release, ...agentMail, NODE_ENV: 'production', DATABASE_URL: secretUrl, PORT: '4330' };
      expect(problemsOf(base)).toEqual(['KS_PUBLIC_ORIGIN: missing_or_wrong_type']);
      expect(problemsOf({ ...base, KS_PUBLIC_ORIGIN: 'http://app.dev.knowscroll.space' })).toEqual([
        'KS_PUBLIC_ORIGIN: https_required',
      ]);
      expect(problemsOf({ ...base, KS_PUBLIC_ORIGIN: 'https://app.dev.knowscroll.space/path' })).toEqual([
        'KS_PUBLIC_ORIGIN: invalid_format',
      ]);
      expect(readApiConfig({ ...base, KS_PUBLIC_ORIGIN: 'http://127.0.0.1:4399' }).identity).toMatchObject({
        publicOrigin: 'http://127.0.0.1:4399',
        secureCookies: false,
      });
      expect(readApiConfig({ ...local, ...agentMail }).identity.publicOrigin).toBe('http://127.0.0.1:4330');
    });

    const pattern = { KS_OPERATOR_SIGN_IN_PATTERN: '*@test.knowscroll.space' };

    it('keeps native sign-in binding off unless it is exactly 1 (re-review N1)', () => {
      const env = { ...local, ...agentMail };
      expect(readApiConfig(env).identity.nativeSignInBinding).toBe(false);
      expect(readApiConfig({ ...env, KS_NATIVE_SIGN_IN_BINDING: '1' }).identity.nativeSignInBinding).toBe(true);
      for (const value of ['true', 'yes', '0', ' 1'])
        expect(problemsOf({ ...env, KS_NATIVE_SIGN_IN_BINDING: value })).toEqual([
          'KS_NATIVE_SIGN_IN_BINDING: not_allowed',
        ]);
    });

    it('accepts operator sign-in only as exactly 1, with a disposable pattern, in an allow-listed world', () => {
      const env = { ...local, ...agentMail };
      expect(readApiConfig(env).identity.operatorSignIn).toBeUndefined();
      expect(readApiConfig({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: '1', ...pattern }).identity.operatorSignIn).toEqual({
        pattern: '*@test.knowscroll.space',
      });
      for (const value of ['true', 'yes', '0', ' 1'])
        expect(problemsOf({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: value, ...pattern })).toEqual([
          'KS_ALLOW_OPERATOR_SIGN_IN: not_allowed',
        ]);
      expect(problemsOf({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: '1' })).toEqual([
        'KS_OPERATOR_SIGN_IN_PATTERN: missing_or_wrong_type',
      ]);
      for (const bad of ['*@*.test', '*@gmail', 'someone*@*', '*@Test.example.com'])
        expect(problemsOf({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: '1', KS_OPERATOR_SIGN_IN_PATTERN: bad })).toEqual([
          'KS_OPERATOR_SIGN_IN_PATTERN: invalid_format',
        ]);
      // An allow-list (review m3): live, and a production world under any other name, are refused.
      for (const world of ['live', 'prod', 'production', 'live-2'])
        expect(
          configurationError(() =>
            readApiConfig({
              ...production,
              ...release,
              KS_WORLD: world,
              DATABASE_URL: secretUrl,
              PORT: '4310',
              KS_ALLOW_OPERATOR_SIGN_IN: '1',
              ...pattern,
            }),
          ).problems,
          world,
        ).toEqual(['KS_ALLOW_OPERATOR_SIGN_IN: refused_in_this_world']);
    });

    it('refuses the operator command outside dev, stage, ci and local, without the flag, and without a pattern', () => {
      const env = {
        KS_WORLD: 'dev',
        DATABASE_URL: secretUrl,
        KS_PUBLIC_ORIGIN: 'https://app.dev.knowscroll.space',
        ...pattern,
      };
      expect(configurationError(() => readOperatorConfig(env)).problems).toEqual([
        'KS_ALLOW_OPERATOR_SIGN_IN: not_enabled',
      ]);
      expect(
        configurationError(() => readOperatorConfig({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: 'true' })).problems,
      ).toEqual(['KS_ALLOW_OPERATOR_SIGN_IN: not_enabled']);
      for (const world of ['live', 'prod', 'production', 'live-2'])
        expect(
          configurationError(() => readOperatorConfig({ ...env, KS_WORLD: world, KS_ALLOW_OPERATOR_SIGN_IN: '1' }))
            .problems,
          world,
        ).toEqual(['KS_WORLD: operator_sign_in_refused_in_this_world']);
      expect(
        configurationError(() =>
          readOperatorConfig({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: '1', KS_OPERATOR_SIGN_IN_PATTERN: '' }),
        ).problems,
      ).toEqual(['KS_OPERATOR_SIGN_IN_PATTERN: missing_or_wrong_type']);
      expect(readOperatorConfig({ ...env, KS_ALLOW_OPERATOR_SIGN_IN: '1' })).toMatchObject({
        world: 'dev',
        publicOrigin: 'https://app.dev.knowscroll.space',
        pattern: '*@test.knowscroll.space',
        database: { applicationName: 'knowscroll-operator-dev' },
      });
    });
  });

  it('defaults the worker to no reasoning provider, with bounded caps and protected-request limits', () => {
    const config = readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local' });
    expect(config.reasoning).toEqual({
      provider: 'none',
      productionEnabled: false,
      roomEnabled: false,
      roomGeneration: 1,
      roomFeedEnabled: false,
      roomScoutsEnabled: false,
      caps: {
        global: { requestsPerDay: 300, tokensPerDay: 3_000_000 },
        scope: { requestsPerDay: 60, tokensPerDay: 600_000 },
        productionScope: { requestsPerDay: 200, tokensPerDay: 3_000_000 },
        roomScope: { requestsPerDay: 100, tokensPerDay: 1_000_000 },
        roleDefault: { requestsPerDay: 200, tokensPerDay: 2_000_000 },
      },
      backgroundSharePercent: 50,
      ambientSharePercent: 30,
      maxRequestBytes: 262_144,
      requestRetentionSeconds: 48 * 3600,
    });
  });

  it('enables nonpersonal production only with the explicit worker setting', () => {
    expect(
      readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_REASONING_PRODUCTION_ENABLED: '1' }).reasoning
        .productionEnabled,
    ).toBe(true);
    expect(
      configurationError(() =>
        readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_REASONING_PRODUCTION_ENABLED: 'true' }),
      ).problems,
    ).toEqual(['KS_REASONING_PRODUCTION_ENABLED: not_allowed']);
  });

  it('requires a token-plan MiniMax key only for the minimax provider, and never echoes it', () => {
    // Fixture keys only.
    const fixtureKey = 'sk-cp-FIXTUREfixtureFIXTUREfixture0000';
    const problemsOf = (env: Record<string, string>) =>
      configurationError(() =>
        readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_REASONING_PROVIDER: 'minimax', ...env }),
      );
    expect(problemsOf({}).problems).toEqual(['MINIMAX_API_KEY: missing_or_wrong_type']);
    const wrongShape = problemsOf({ MINIMAX_API_KEY: 'sk-payg-hunter2-very-secret-key' });
    expect(wrongShape.problems).toEqual(['MINIMAX_API_KEY: invalid_format']);
    expect(wrongShape.message).not.toContain('hunter2');
    expect(
      configurationError(() =>
        readWorkerConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'local', KS_REASONING_PROVIDER: 'openai' }),
      ).problems,
    ).toEqual(['KS_REASONING_PROVIDER: not_allowed']);
    expect(
      configurationError(() =>
        readWorkerConfig({
          DATABASE_URL: secretUrl,
          KS_WORLD: 'local',
          KS_REASONING_PROVIDER: 'minimax',
          MINIMAX_API_KEY: fixtureKey,
          KS_MINIMAX_MODEL: 'MiniMax-M3.1-Flash-Preview',
        }),
      ).problems,
    ).toEqual(['KS_MINIMAX_MODEL: not_allowed']);
    // A floor of 0 would switch the quota preflight off: refused.
    expect(
      configurationError(() =>
        readWorkerConfig({
          DATABASE_URL: secretUrl,
          KS_WORLD: 'local',
          KS_REASONING_PROVIDER: 'minimax',
          MINIMAX_API_KEY: fixtureKey,
          KS_MINIMAX_QUOTA_FLOOR_PERCENT: '0',
        }),
      ).problems,
    ).toEqual(['KS_MINIMAX_QUOTA_FLOOR_PERCENT: out_of_range']);
    const config = readWorkerConfig({
      DATABASE_URL: secretUrl,
      KS_WORLD: 'local',
      KS_REASONING_PROVIDER: 'minimax',
      MINIMAX_API_KEY: fixtureKey,
      KS_REASONING_SCOPE_REQUESTS_PER_DAY: '5',
    });
    expect(config.reasoning.minimax).toEqual({
      apiKey: fixtureKey,
      model: 'MiniMax-M3.1-Flash',
      requestTimeoutMs: 240_000,
      quotaFloorPercent: 25,
    });
    expect(config.reasoning.caps.scope.requestsPerDay).toBe(5);
  });

  it('gives a reasoning request four minutes by default, accepts five and refuses more', () => {
    // A Scroll writer request took up to 126 s on MiniMax-M3.1-Flash; an attempt cut off after the
    // request left is `unknown` and never resent, so the default must not sit near the real latency.
    const env = {
      DATABASE_URL: secretUrl,
      KS_WORLD: 'local',
      KS_REASONING_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
    };
    expect(readWorkerConfig(env).reasoning.minimax?.requestTimeoutMs).toBe(240_000);
    expect(
      readWorkerConfig({ ...env, KS_MINIMAX_REQUEST_TIMEOUT_MS: '300000' }).reasoning.minimax?.requestTimeoutMs,
    ).toBe(300_000);
    expect(
      configurationError(() => readWorkerConfig({ ...env, KS_MINIMAX_REQUEST_TIMEOUT_MS: '300001' })).problems,
    ).toEqual(['KS_MINIMAX_REQUEST_TIMEOUT_MS: out_of_range']);
  });

  it('reads the worker operator command configuration (world and database only)', () => {
    expect(configurationError(() => readWorkerOperatorConfig({ DATABASE_URL: secretUrl })).problems).toEqual([
      'KS_WORLD: missing_or_wrong_type',
    ]);
    const config = readWorkerOperatorConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'dev' });
    expect(config.world).toBe('dev');
    expect(config.database.applicationName).toBe('knowscroll-operator-dev');
  });

  it('defaults every role to MiniMax-M3.1-Flash unless the operator names another model', () => {
    const env = {
      KS_WORLD: 'local',
      DATABASE_URL: secretUrl,
      KS_REASONING_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
    };
    expect(readScrollProductionOperatorConfig(env).reasoning.minimax?.model).toBe('MiniMax-M3.1-Flash');
    expect(
      readScrollProductionOperatorConfig({ ...env, KS_MINIMAX_MODEL: 'MiniMax-M3' }).reasoning.minimax?.model,
    ).toBe('MiniMax-M3');
    expect(
      configurationError(() => readScrollProductionOperatorConfig({ ...env, KS_MINIMAX_MODEL: 'MiniMax-M9' })).problems,
    ).toContain('KS_MINIMAX_MODEL: not_allowed');
  });

  it('keeps Scroll production disabled and pins its expected grant generation explicitly', () => {
    const env = { KS_WORLD: 'local', DATABASE_URL: secretUrl };
    const config = readScrollProductionOperatorConfig(env);
    expect(config.reasoning.provider).toBe('none');
    expect(config.reasoning.productionEnabled).toBe(false);
    expect(config.productionGeneration).toBe(1);
    expect(
      readScrollProductionOperatorConfig({ ...env, KS_SCROLL_PRODUCTION_GENERATION: '2' }).productionGeneration,
    ).toBe(2);
    expect(
      configurationError(() =>
        readScrollProductionOperatorConfig({ ...env, KS_SCROLL_PRODUCTION_GENERATION: '0' }),
      ).problems.some((problem) => problem.startsWith('KS_SCROLL_PRODUCTION_GENERATION:')),
    ).toBe(true);
    expect(
      configurationError(() => readScrollProductionOperatorConfig({ ...env, KS_WORLD: 'live' })).problems,
    ).toContain('KS_WORLD: operator_command_refused_in_this_world');
  });
});

describe('the Reel operator commands read the pool from the world’s own database settings', () => {
  const inputs = {
    DATABASE_URL: secretUrl,
    KS_WORLD: 'dev',
    KS_MEDIA_ROOT: '/srv/knowscroll/dev/media-v2',
    KS_CUTROOM_ORIGIN: 'http://127.0.0.1:8797',
    KS_CUTROOM_ARTIFACT_ROOT: '/srv/knowscroll/cutroom-pool/artifacts',
  };

  it('points the world’s role and password at knowscroll_pool unless a pool URL is given', () => {
    const config = readReelOperatorConfig(inputs);
    expect(config).toMatchObject({
      world: 'dev',
      mediaRoot: '/srv/knowscroll/dev/media-v2',
      cutroomOrigin: 'http://127.0.0.1:8797',
      ffprobePath: '/usr/bin/ffprobe',
    });
    const pool = new URL(config.poolUrl);
    expect(pool.pathname).toBe('/knowscroll_pool');
    expect(pool.username).toBe('ks_api');
    expect(pool.hostname).toBe('127.0.0.1');
    const explicit = 'postgres://pool_user:other@127.0.0.1:5432/another_pool';
    expect(readReelOperatorConfig({ ...inputs, KS_POOL_DATABASE_URL: explicit }).poolUrl).toBe(explicit);
  });

  it('refuses a live world, a Cutroom that is not on loopback and a pool that is not a Postgres URL, naming no value', () => {
    expect(configurationError(() => readReelOperatorConfig({ ...inputs, KS_WORLD: 'live' })).problems).toContain(
      'KS_WORLD: operator_command_refused_in_this_world',
    );
    for (const origin of ['http://remote.example', 'https://127.0.0.1', 'http://user:secret@127.0.0.1'])
      expect(() => readReelOperatorConfig({ ...inputs, KS_CUTROOM_ORIGIN: origin })).toThrow();
    const error = configurationError(() => readReelOperatorConfig({ ...inputs, KS_POOL_DATABASE_URL: 'mysql://x' }));
    expect(error.problems).toEqual(['KS_POOL_DATABASE_URL: must_be_a_postgres_url']);
    expect(
      configurationError(() => readReelOperatorConfig({ ...inputs, KS_MEDIA_ROOT: undefined })).problems.join(' '),
    ).not.toContain('hunter2');
  });
});
