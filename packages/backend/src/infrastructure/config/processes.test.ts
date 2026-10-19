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

  it('refuses the test-only caller adapter unless NODE_ENV=test', () => {
    expect(() =>
      readApiConfig({
        NODE_ENV: 'production',
        DATABASE_URL: secretUrl,
        PORT: '4330',
        KS_AUTH_ADAPTER: 'test-bearer',
        ...release,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      readApiConfig({ NODE_ENV: 'development', DATABASE_URL: secretUrl, PORT: '4330', KS_AUTH_ADAPTER: 'test-bearer' }),
    ).toThrow(ConfigurationError);
    expect(
      readApiConfig({ NODE_ENV: 'test', DATABASE_URL: secretUrl, PORT: '4330', KS_AUTH_ADAPTER: 'test-bearer' })
        .authAdapter,
    ).toBe('test-bearer');
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
