import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationRegistry } from '@knowscroll/migrations';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp } from '../support/processes.js';

/**
 * Boots the deployed release trees (`pnpm deploy` output of @knowscroll/api and
 * @knowscroll/worker) the way the VPS runs them. Evidence label: CI fixture + real database.
 * The commit and artifact hash below are fixtures, not a real release's identity.
 */
const fixtureCommit = (process.env['GITHUB_SHA'] ?? '0'.repeat(40)).toLowerCase();
const fixtureArtifact = createHash('sha256').update(`ci-fixture-artifact:${fixtureCommit}`).digest('hex');
const latestMigration = migrationRegistry.at(-1)?.name ?? 'none';

describe('the deployed release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  beforeAll(async () => {
    database = await createEmptyDatabase('release_boot');
  });
  afterAll(async () => {
    await database.drop();
  });

  it('migrates an empty database with dist/migrate.js, and a second run applies nothing', async () => {
    const first = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await first.exited()).toBe(0);
    expect(first.records.find((record) => record.event === 'migrate.completed')).toMatchObject({
      count: migrationRegistry.length,
      migration: latestMigration,
    });

    const second = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await second.exited()).toBe(0);
    expect(second.records.find((record) => record.event === 'migrate.completed')).toMatchObject({
      count: 0,
      migration: latestMigration,
    });
  });

  it('serves /health in production with its release identity and stops cleanly on SIGTERM', async () => {
    const port = await freePort();
    const api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'production',
      KS_WORLD: 'ci',
      KS_COMMIT: fixtureCommit,
      KS_ARTIFACT_SHA256: fixtureArtifact,
      DATABASE_URL: database.url,
      PORT: String(port),
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`http://127.0.0.1:${port}/health`);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      world: 'ci',
      commit: fixtureCommit,
      artifact: fixtureArtifact,
      migration: latestMigration,
      relay: 'listening',
    });

    const missing = await fetch(`http://127.0.0.1:${port}/no-such-route`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/problem+json');
    expect(await missing.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });

    expect(await api.stop('SIGTERM')).toBe(0);
    expect(api.records.map((record) => record.event)).toEqual(
      expect.arrayContaining(['process.stopping', 'process.stopped']),
    );
    expect(api.rawOutput()).not.toContain(database.url);
  });

  it('refuses to start in production without a release identity', async () => {
    const port = await freePort();
    const api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'production',
      DATABASE_URL: database.url,
      PORT: String(port),
    });
    expect(await api.exited()).toBe(1);
    expect(api.records.map((record) => record.event)).toEqual(['config.invalid']);
  });

  it('starts the worker with its explicit registry and drains to exit 0 on SIGTERM', async () => {
    const worker = startReleaseProcess('worker', 'main', {
      NODE_ENV: 'production',
      KS_WORLD: 'ci',
      KS_COMMIT: fixtureCommit,
      KS_ARTIFACT_SHA256: fixtureArtifact,
      DATABASE_URL: database.url,
    });
    await worker.waitForEvent('process.started');
    expect(await worker.stop('SIGTERM')).toBe(0);
    expect(worker.records.map((record) => record.event)).toEqual(
      expect.arrayContaining(['jobs.consumers_draining', 'process.stopped']),
    );
  });
});
