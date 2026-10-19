import { describe, expect, it } from 'vitest';
import { ConfigurationError, readApiConfig, readWorkerConfig } from './index.js';

const secretUrl = 'postgres://ks_api:hunter2-very-secret@127.0.0.1:5432/knowscroll_v2_dev';
const release = {
  KS_WORLD: 'dev',
  KS_COMMIT: '0123456789abcdef0123456789abcdef01234567',
  KS_ARTIFACT_SHA256: 'a'.repeat(64),
};

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
    const config = readApiConfig({ NODE_ENV: 'production', DATABASE_URL: secretUrl, PORT: '4330', ...release });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      world: 'dev',
      commit: release.KS_COMMIT,
      artifactSha256: release.KS_ARTIFACT_SHA256,
      listen: { host: '127.0.0.1', port: 4330 },
    });
    expect(config.database.applicationName).toBe('knowscroll-api-dev');
  });

  it('refuses production without release identity', () => {
    const error = configurationError(() =>
      readApiConfig({ NODE_ENV: 'production', DATABASE_URL: secretUrl, PORT: '4330' }),
    );
    expect(error.problems.map((problem) => problem.split(':')[0])).toEqual([
      'KS_WORLD',
      'KS_COMMIT',
      'KS_ARTIFACT_SHA256',
    ]);
  });

  it('defaults release identity outside production', () => {
    const config = readWorkerConfig({ DATABASE_URL: secretUrl });
    expect(config).toMatchObject({
      nodeEnv: 'development',
      world: 'local',
      commit: 'unknown',
      artifactSha256: 'unknown',
    });
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
    ]);
    for (const problem of error.problems) expect(problem).toMatch(/^[A-Z][A-Z0-9_]*: [a-z_]+$/);
  });

  it('refuses the test-only caller adapter unless NODE_ENV=test in a ci or local world', () => {
    const problemsOf = (env: Record<string, string>) =>
      configurationError(() =>
        readApiConfig({ DATABASE_URL: secretUrl, PORT: '4330', KS_AUTH_ADAPTER: 'test-bearer', ...env }),
      ).problems;
    expect(problemsOf({ NODE_ENV: 'production', ...release })).toContain('KS_AUTH_ADAPTER: refused_outside_test');
    expect(problemsOf({ NODE_ENV: 'development' })).toContain('KS_AUTH_ADAPTER: refused_outside_test');
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
        }).authAdapter,
      ).toBe('test-bearer');
    }
  });

  it('requires the personal-scope lock wait to end before the statement timeout', () => {
    for (const read of [readApiConfig, readWorkerConfig]) {
      const error = configurationError(() =>
        read({
          DATABASE_URL: secretUrl,
          PORT: '4330',
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
      }),
    );
    expect(error.message).not.toContain('hunter2');
    expect(error.message.toLowerCase()).not.toContain('hunter2');
    expect(error.problems.length).toBeGreaterThan(0);
  });
});
