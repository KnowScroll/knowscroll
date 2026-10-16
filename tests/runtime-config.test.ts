/**
 * #201 — the API's runtime configuration. Server mode (NODE_ENV=production) runs a world on the
 * VPS behind Caddy: no development identity, exactly one trusted proxy hop, and the world and
 * commit it reports on /health. Development mode is what every journey and the Mac use today and
 * must not change. Pure unit tests — no database, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeConfigError,
  readRuntimeConfig,
} from '../apps/api/src/http/runtime-config.ts';

const COMMIT = '831e094929c9c1b2b6bbd1d58d0e0ac0d1e2f3a4';

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    readRuntimeConfig(env);
  } catch (error) {
    assert.ok(error instanceof RuntimeConfigError);
    return error.problems;
  }
  assert.fail('expected readRuntimeConfig to refuse');
}

test('server mode refuses KS_DEV_TOKEN', () => {
  const problems = problemsOf({
    NODE_ENV: 'production',
    KS_WORLD: 'dev',
    KS_COMMIT: COMMIT,
    KS_DEV_TOKEN: 'a-development-token-of-24+-characters',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /KS_DEV_TOKEN/);
});

test('server mode requires KS_WORLD and KS_COMMIT and names every missing setting at once', () => {
  const problems = problemsOf({ NODE_ENV: 'production' });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('KS_WORLD')));
  assert.ok(problems.some((p) => p.includes('KS_COMMIT')));
});

test('server mode rejects an unknown world and a commit that is not hex', () => {
  const problems = problemsOf({
    NODE_ENV: 'production',
    KS_WORLD: 'prod',
    KS_COMMIT: 'not-a-commit',
  });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('KS_WORLD')));
  assert.ok(problems.some((p) => p.includes('KS_COMMIT')));
});

test('server mode accepts a full configuration and trusts exactly the loopback proxy', () => {
  assert.deepEqual(
    readRuntimeConfig({
      NODE_ENV: 'production',
      KS_WORLD: 'stage',
      KS_COMMIT: COMMIT,
      PORT: '4320',
    }),
    {
      mode: 'server',
      port: 4320,
      developmentToken: null,
      trustProxy: '127.0.0.1',
      world: 'stage',
      commit: COMMIT,
    },
  );
});

test('development mode is unchanged: the token passes through, no proxy is trusted, port 4310', () => {
  assert.deepEqual(readRuntimeConfig({ KS_DEV_TOKEN: 'abc' }), {
    mode: 'development',
    port: 4310,
    developmentToken: 'abc',
    trustProxy: false,
  });
  // An unset token stays the empty string buildApp has always refused with its own message.
  assert.equal(readRuntimeConfig({}).developmentToken, '');
});

test('PORT must be a whole number from 1 to 65535 when it is set, in either mode', () => {
  for (const PORT of ['0', '65536', '43.1', 'x']) {
    assert.ok(
      problemsOf({ PORT }).some((p) => p.includes('PORT')),
      `PORT=${PORT}`,
    );
  }
});
