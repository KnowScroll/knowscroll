import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { SCOPE_HEADER, scopeClaimOf, type InteractionEvent } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { cutroomFixture, fixtureRunId } from '../support/cutroom-fixture.js';
import { apiClient } from '../support/api-client.js';
import {
  freePort,
  releaseDirectory,
  startReleaseProcess,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';
import { textCapabilities } from '../support/scroll.js';

/** Actual installed backend parsers, operator, API/range boundary and durable evidence, through
 * deployed release trees. Evidence: CI fixtures + generated video + real PostgreSQL, no provider. */
describe('Reel journey in the installed release trees', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let fixture: Awaited<ReturnType<typeof cutroomFixture>>;
  let root: string;
  let api: ReleaseProcess;
  let worker: ReleaseProcess;
  let origin: string;
  let person: FixturePerson;
  let stranger: FixturePerson;
  let path: string;
  let exposureId: string;
  const assetId = '2074e431-76a4-45be-b78f-3d65914277ff';
  const output: string[] = [];
  const headers = (who = person) => ({
    authorization: `Bearer test.${who.accountId}`,
    [SCOPE_HEADER]: scopeClaimOf({ accountId: who.accountId, privacyEpoch: 1 }),
  });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ks-release-reel-'));
    fixture = await cutroomFixture(root);
    database = await createEmptyDatabase('release_reel');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'reel-fixture', poolMax: 3, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    person = await seedPerson(handle.db);
    stranger = await seedPerson(handle.db);
    const env = {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_MEDIA_ROOT: fixture.mediaRoot,
      KS_CUTROOM_ORIGIN: fixture.origin,
      KS_CUTROOM_ARTIFACT_ROOT: fixture.artifactRoot,
    };
    const child = spawn(
      process.execPath,
      [
        'dist/operator.js',
        'content',
        'import-cutroom-reel',
        '--run',
        fixtureRunId,
        '--script',
        'greenhouse',
        '--fixture',
      ],
      {
        cwd: join(releaseDirectory(), 'worker'),
        env: { PATH: process.env['PATH'] ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    output.push(stdout, stderr);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ kind: 'created', assetId });
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    api = startReleaseProcess('api', 'main', {
      ...env,
      PORT: String(port),
      KS_AUTH_ADAPTER: 'test-bearer',
      KS_MAIL_SENDER: 'fixture',
    });
    worker = startReleaseProcess('worker', 'main', env);
    await Promise.all([api.waitForEvent('process.started'), worker.waitForEvent('process.started')]);
    await waitForHttp(`${origin}/health`);
  });
  afterAll(async () => {
    if (api) await api.stop();
    if (worker) await worker.stop();
    if (handle) await handle.close();
    if (database) await database.drop();
    if (fixture) await fixture.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('opens/activates an admitted immutable Reel, grants it, serves bounded ranges and conditional requests', async () => {
    const client = apiClient(
      origin,
      `Bearer test.${person.accountId}`,
      scopeClaimOf({ accountId: person.accountId, privacyEpoch: 1 }),
    );
    const opened = await client.experience.openExposure({
      commandId: randomUUID(),
      target: { kind: 'reel', assetId },
      origin: { kind: 'direct' },
      capabilities: textCapabilities,
    });
    expect(opened.status).toBeUndefined();
    if (opened.status !== undefined) throw new Error('Direct Reel fixture returned a Composer outcome');
    expect(opened.kind).toBe('reel');
    exposureId = opened.exposureId;
    const grant = await client.media.grant({ exposureId });
    path = grant.path;
    expect(grant.document).toMatchObject({ fixture: true, captions: 'burned_in' });
    expect(grant.document).not.toHaveProperty('provenance');
    await client.experience.activateExposure({ commandId: randomUUID(), exposureId });
    const first = await fetch(`${origin}${path}`, { headers: { ...headers(), range: 'bytes=0-31' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toMatch(/^bytes 0-31\//);
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expect(first.headers.get('content-encoding')).toBeNull();
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await first.arrayBuffer()).byteLength).toBe(32);
    const etag = first.headers.get('etag')!;
    const suffix = await fetch(`${origin}${path}`, { headers: { ...headers(), range: 'bytes=-8' } });
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(8);
    const refused = await fetch(`${origin}${path}`, { headers: { ...headers(), range: 'bytes=999999999-' } });
    expect(refused.status).toBe(416);
    const multi = await fetch(`${origin}${path}`, { headers: { ...headers(), range: 'bytes=0-1,3-4' } });
    expect(multi.status).toBe(416);
    const unchanged = await fetch(`${origin}${path}`, { headers: { ...headers(), 'if-none-match': etag } });
    expect(unchanged.status).toBe(304);
    const head = await fetch(`${origin}${path}`, { method: 'HEAD', headers: headers() });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const renewed = await client.media.grant({ exposureId });
    expect(renewed.document).toEqual(grant.document);
    expect(await handle.db.selectFrom('experience.exposures').select('id').execute()).toHaveLength(1);
  });
  it('projects unique media, and retries the same batch without adding evidence twice', async () => {
    await sql`update experience.exposures set activated_at = now() - interval '1 minute' where id = ${exposureId}::uuid`.execute(
      handle.db,
    );
    const client = apiClient(
      origin,
      `Bearer test.${person.accountId}`,
      scopeClaimOf({ accountId: person.accountId, privacyEpoch: 1 }),
    );
    const sessionId = randomUUID();
    const samples = Array.from({ length: 16 }, (_, index) => ({
      activeMs: [index * 1000, (index + 1) * 1000] as [number, number],
      mediaMs: [index * 1000, (index + 1) * 1000] as [number, number],
    }));
    const event: InteractionEvent = {
      schemaVersion: 'interaction.v1',
      eventId: randomUUID(),
      sessionId,
      deviceSequence: 1,
      exposureId,
      assetId,
      assetRevision: 1,
      occurredAt: new Date().toISOString(),
      kind: 'reel.playback',
      payload: { samples },
    };
    expect(await client.observations.submit({ instrumentationVersion: 1, events: [event] })).toMatchObject({
      accepted: 1,
    });
    expect(await client.observations.submit({ instrumentationVersion: 1, events: [event] })).toMatchObject({
      duplicates: 1,
    });
    await expect
      .poll(async () => (await client.diagnostics.evidence({ exposureId })).evidence?.qualification, { timeout: 20000 })
      .toBe('qualified');
    const evidence = await client.diagnostics.evidence({ exposureId });
    expect(evidence.observations.count).toBe(1);
    expect(evidence.evidence?.q).toBe(0.8);
  });
  it('refuses foreign, absent, stale epoch, revoked admission and credential canaries without leaking grant URLs', async () => {
    expect((await fetch(`${origin}${path}`, { headers: headers(stranger) })).status).toBe(404);
    expect(
      (await fetch(`${origin}/media/${'a'.repeat(64)}?grant=grant-canary-secret`, { headers: headers() })).status,
    ).toBe(404);
    expect((await fetch(`${origin}${path}`)).status).toBe(404);
    await handle.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', assetId).execute();
    expect((await fetch(`${origin}${path}`, { headers: headers() })).status).toBe(404);
    await handle.db.updateTable('content.assets').set({ status: 'admitted' }).where('id', '=', assetId).execute();
    await handle.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect((await fetch(`${origin}${path}`, { headers: headers() })).status).toBe(404);
    const logs = `${api.rawOutput()}${worker.rawOutput()}${output.join('')}`;
    expect(logs).not.toContain('grant-canary-secret');
    expect(logs).not.toContain(path);
    expect(logs).not.toContain('Bearer test.');
    expect(logs).not.toContain(fixture.artifactRoot);
  });
});
