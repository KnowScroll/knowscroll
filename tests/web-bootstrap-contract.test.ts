/**
 * #115 — the other half of "the web client's schemas cannot drift": the REAL server responses for
 * the bootstrap reads the web client parses (`GET /v1/universe`, `/v1/feed`, `/v1/worlds`) must
 * strictly satisfy the same shared schemas (`packages/contracts/src/web-bootstrap.ts`) the web
 * client and its fixtures use. A field the server grows without the shared contract (ADR-0030's
 * `recordingPausedAt`, which #120 shipped past every check) now fails the backend suite in CI,
 * not the owner's browser. Covers an empty universe, a feed decision and a derived world system.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';
import { feedResponseSchema, universeSchema, worldSystemResponseSchema } from '../packages/contracts/src/web-bootstrap.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Web bootstrap contract tests require an isolated knowscroll_test_* database');
}

const app = buildApp(randomBytes(32).toString('hex'));
after(async () => { await app.close(); await pool.end(); });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

async function read(token: string, url: string) {
  const response = await app.inject({ url, headers: headers(token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('real bootstrap responses strictly satisfy the shared web contract, before and after an encounter', async () => {
  const reader = await provisionIdentity();
  universeSchema.parse(await read(reader.token, '/v1/universe'));
  worldSystemResponseSchema.parse(await read(reader.token, '/v1/worlds'));

  const feed = feedResponseSchema.parse(await read(reader.token, '/v1/feed'));
  assert.ok(feed.items.length > 0, 'the seeded editorial library offers at least one Scroll');
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(reader.token),
    payload: { decisionId: feed.decisionId, assetId: feed.items[0]!.assetId, clientExposureId: randomUUID() } });
  assert.equal(exposure.statusCode, 201, exposure.body);

  const worlds = worldSystemResponseSchema.parse(await read(reader.token, '/v1/worlds'));
  assert.ok(worlds.system !== null, 'an encounter derives a system');
  universeSchema.parse(await read(reader.token, '/v1/universe'));
});
