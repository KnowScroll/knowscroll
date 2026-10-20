import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  readApiConfig,
  readMigrateConfig,
  readOperatorConfig,
  readWorkerConfig,
  readWorkerOperatorConfig,
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
      caps: {
        global: { requestsPerDay: 300, tokensPerDay: 3_000_000 },
        scope: { requestsPerDay: 60, tokensPerDay: 600_000 },
        roleDefault: { requestsPerDay: 200, tokensPerDay: 2_000_000 },
      },
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
      model: 'MiniMax-M3',
      requestTimeoutMs: 60_000,
      quotaFloorPercent: 25,
    });
    expect(config.reasoning.caps.scope.requestsPerDay).toBe(5);
  });

  it('reads the worker operator command configuration (world and database only)', () => {
    expect(configurationError(() => readWorkerOperatorConfig({ DATABASE_URL: secretUrl })).problems).toEqual([
      'KS_WORLD: missing_or_wrong_type',
    ]);
    const config = readWorkerOperatorConfig({ DATABASE_URL: secretUrl, KS_WORLD: 'dev' });
    expect(config.world).toBe('dev');
    expect(config.database.applicationName).toBe('knowscroll-operator-dev');
  });
});
