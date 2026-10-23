import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVELOPMENT_SESSION_COOKIE_NAME } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';

/** Installed Nest + actual disposable PostgreSQL. CI bearer callers only, no worker/provider,
 * authored geography or generated formation. These reads must not create even an empty state row. */
describe('own Geography HTTP boundary in the installed release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let person: FixturePerson;
  let stranger: FixturePerson;
  const readPath = '/v1/universe/geography/read';
  const deltaPath = '/v1/universe/geography/deltas/read';
  const query = { selection: { kind: 'universe' as const }, limit: 100 };
  const deltaQuery = { afterGeographyRevision: 0, limit: 10 };
  const headers = (who = person, epoch = 1) => ({
    authorization: `Bearer test.${who.accountId}`,
    'x-ks-scope': `${who.accountId}:${epoch}`,
  });
  const post = (path: string, body: unknown, extra: Record<string, string> = headers()) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  async function expectProblem(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body: unknown = await response.json();
    expect(body).toMatchObject({ status, code });
    return body;
  }
  async function counts() {
    const result = await sql<{
      state: number;
      runs: number;
      objects: number;
      relations: number;
      deltas: number;
      receipts: number;
      jobs: number;
      observations: number;
      attempts: number;
      revision: number;
    }>`select
      (select count(*)::int from geography.state) as state,
      (select count(*)::int from geography.runs) as runs,
      (select count(*)::int from geography.objects) as objects,
      (select count(*)::int from geography.relations) as relations,
      (select count(*)::int from geography.deltas) as deltas,
      (select count(*)::int from receipts.personal_commands) as receipts,
      (select count(*)::int from pgboss.job) as jobs,
      (select count(*)::int from evidence.observations) as observations,
      (select count(*)::int from reasoning.external_attempts) as attempts,
      (select revision from identity.universes where id=${person.universeId}::uuid) as revision`.execute(handle.db);
    return result.rows[0];
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('release_geography');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'geography-http-fixture', poolMax: 3, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    person = await seedPerson(handle.db);
    stranger = await seedPerson(handle.db);
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: String(port),
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'test-bearer',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_BODY_LIMIT_BYTES: '4096',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`${origin}/health`);
  });
  afterAll(async () => {
    try {
      if (api !== undefined) {
        expect(await api.stop()).toBe(0);
        expect(api.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
      }
    } finally {
      try {
        if (handle !== undefined) await handle.close();
      } finally {
        if (database !== undefined) await database.drop();
      }
    }
  });

  it('serves typed empty/current catch-up without creating state, jobs, receipts or evidence', async () => {
    const before = await counts();
    const client = apiClient(origin, headers().authorization, `${person.accountId}:1`);
    for (let n = 0; n < 3; n += 1) {
      const snapshot = await client.geography.read(query);
      expect(snapshot).toMatchObject({
        version: 'geography-snapshot.v1',
        universeId: person.universeId,
        privacyEpoch: 1,
        personalWatermark: before!.revision,
        geography: { revision: 0, structureRevision: 0, activityRevision: 0 },
        selection: query.selection,
        status: 'empty',
      });
      expect(snapshot).not.toHaveProperty('page');
      expect(await client.geography.deltas(deltaQuery)).toMatchObject({
        version: 'universe-deltas.v1',
        universeId: person.universeId,
        privacyEpoch: 1,
        personalWatermark: before!.revision,
        status: 'available',
        afterGeographyRevision: 0,
        deltas: [],
        hasMore: false,
      });
    }
    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({ state: 0, runs: 0, objects: 0, relations: 0, deltas: 0 });
  });

  it('preserves global origin/session/scope/JSON/size and strict read-only input guards', async () => {
    const before = await counts();
    for (const [path, body] of [
      [readPath, query],
      [deltaPath, deltaQuery],
    ] as const) {
      await expectProblem(await post(path, body, {}), 401, 'UNAUTHENTICATED');
      await expectProblem(
        await post(path, body, {
          cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=fixture-not-a-session`,
        }),
        403,
        'ORIGIN_NOT_ALLOWED',
      );
      await expectProblem(await post(path, body, { authorization: headers().authorization }), 409, 'SCOPE_MISMATCH');
      await expectProblem(
        await post(path, body, { ...headers(), origin: 'https://foreign.invalid' }),
        403,
        'ORIGIN_NOT_ALLOWED',
      );
      await expectProblem(
        await post(path, body, {
          ...headers(),
          'x-ks-scope': `${stranger.accountId}:1`,
        }),
        409,
        'SCOPE_MISMATCH',
      );
      await expectProblem(await post(path, { ...body, accountId: person.accountId }), 400, 'INVALID_REQUEST');
      await expectProblem(await post(path, { ...body, commandId: randomUUID() }), 400, 'INVALID_REQUEST');
      await expectProblem(await post(path, { ...body, padding: 'x'.repeat(5000) }), 413, 'PAYLOAD_TOO_LARGE');
      await expectProblem(
        await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'text/plain' },
          body: 'private',
        }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      await expectProblem(await fetch(`${origin}${path}`, { headers: headers() }), 404, 'NOT_FOUND');
    }
    await expectProblem(await post(readPath, { ...query, limit: 101 }), 400, 'INVALID_REQUEST');
    await expectProblem(await post(deltaPath, { ...deltaQuery, limit: 11 }), 400, 'INVALID_REQUEST');
    expect(await counts()).toEqual(before);
  });

  it('refuses mixed-scope cursors and future deltas without fabricating progress or disclosing another world', async () => {
    const before = await counts();
    const cursor = {
      universeId: stranger.universeId,
      privacyEpoch: 1,
      geographyRevision: 0,
      selection: query.selection,
      afterObjectId: randomUUID(),
    };
    const response = await post(readPath, { ...query, cursor });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ universeId: person.universeId, status: 'unavailable', reason: 'snapshot_expired' });
    expect(body).not.toHaveProperty('page');
    expect(JSON.stringify(body)).not.toContain(stranger.universeId);
    for (const systemId of [stranger.universeId, randomUUID()])
      await expectProblem(
        await post(readPath, { selection: { kind: 'system', systemId }, limit: 100 }),
        404,
        'NOT_FOUND',
      );
    const delta = await post(deltaPath, { afterGeographyRevision: 1, limit: 10 });
    expect(delta.status).toBe(200);
    expect(await delta.json()).toMatchObject({ universeId: person.universeId, status: 'snapshot_required' });
    expect(await counts()).toEqual(before);
  });

  it('fences old epoch reads before current own-world access and leaves the new epoch empty', async () => {
    const p = await seedPerson(handle.db);
    await handle.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', p.universeId)
      .execute();
    const before = await counts();
    await expectProblem(await post(readPath, query, headers(p)), 409, 'SCOPE_MISMATCH');
    await expectProblem(await post(deltaPath, deltaQuery, headers(p)), 409, 'SCOPE_MISMATCH');
    const response = await post(readPath, query, headers(p, 2));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ universeId: p.universeId, privacyEpoch: 2, status: 'empty' });
    expect(await counts()).toEqual(before);
  });
});
