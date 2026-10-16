/**
 * #201 — the app as a server builds it: no development session when the token is null, the real
 * client address only when the loopback proxy is trusted, and /health naming the world and commit
 * a deploy expects. Uses the test database (scripts/test.sh), never a provider.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { pool } from '@knowscroll/db';
import { buildApp } from '../apps/api/src/app.ts';

test.after(async () => {
  await pool.end();
});

test('buildApp(null) enrols no development session, so a would-be token is refused', async () => {
  const app = buildApp(null);
  await app.ready();
  try {
    const token = randomBytes(24).toString('hex');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/universe',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('a development token still enrols its session exactly as before', async () => {
  const token = randomBytes(24).toString('hex');
  const app = buildApp(token);
  await app.ready();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/universe',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('buildApp refuses a short development token, as it always has', () => {
  assert.throws(() => buildApp('short'), /at least 24 characters/);
});

for (const [label, trustProxy, expected] of [
  [
    'with trustProxy 127.0.0.1, the forwarded client is the address',
    '127.0.0.1',
    '203.0.113.9',
  ],
  ['without trustProxy, X-Forwarded-For is ignored', false, '127.0.0.1'],
] as const) {
  test(label, async () => {
    const app = buildApp(null, { trustProxy });
    app.get('/__test/ip', async (req) => ({ ip: req.ip }));
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__test/ip',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      assert.equal(res.json().ip, expected);
    } finally {
      await app.close();
    }
  });
}

test('/health reports the world and commit it was built with', async () => {
  const commit = 'a'.repeat(40);
  const app = buildApp(null, { health: { world: 'dev', commit } });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      status: 'ok',
      database: true,
      world: 'dev',
      commit,
    });
  } finally {
    await app.close();
  }
});

test('/health says local when no world was given (the Mac and every journey)', async () => {
  const app = buildApp(randomBytes(24).toString('hex'));
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(res.json(), {
      status: 'ok',
      database: true,
      world: 'local',
      commit: 'local',
    });
  } finally {
    await app.close();
  }
});
