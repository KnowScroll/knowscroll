import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperatorPanelsSchema, type CreateContentRequest } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import {
  freePort,
  releaseDirectory,
  startReleaseProcess,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';
import { textCapabilities } from '../support/scroll.js';

/**
 * The operator routes in the installed release (#248, D-044): the same 404 for everyone who is not
 * an operator of the world, on every route, and the panels and a journey for the one who is. CI
 * bearer callers; the operator is named by `KS_OPERATOR_ACCOUNTS`.
 */
describe('operator routes in the installed release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let operator: FixturePerson;
  let stranger: FixturePerson;
  let nameless: FixturePerson;
  let requestId: string;
  const headers = (who: FixturePerson) => ({
    authorization: `Bearer test.${who.accountId}`,
    'x-ks-scope': `${who.accountId}:1`,
  });
  const get = (path: string, who?: FixturePerson) =>
    fetch(`${origin}${path}`, { headers: who === undefined ? {} : headers(who) });
  async function expectProblem(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toMatchObject({ status, code });
  }
  async function personWithAddress(address: string): Promise<FixturePerson> {
    const person = await seedPerson(handle.db);
    await handle.db.insertInto('identity.email_addresses').values({ account_id: person.accountId, address }).execute();
    return person;
  }

  beforeAll(async () => {
    database = await createEmptyDatabase('release_operator');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'operator-http-fixture', poolMax: 3, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    operator = await personWithAddress('ops@ci.invalid');
    stranger = await personWithAddress('someone@ci.invalid');
    nameless = await seedPerson(handle.db);
    // One admitted Scroll, so the operator can ask for it and have a request to inspect.
    const child = spawn(
      process.execPath,
      [
        'dist/operator.js',
        'content',
        'import-editorial',
        '--file',
        join(
          releaseDirectory(),
          'api/node_modules/@knowscroll/backend/dist/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json',
        ),
      ],
      {
        cwd: join(releaseDirectory(), 'api'),
        env: { PATH: process.env['PATH'] ?? '', KS_WORLD: 'ci', DATABASE_URL: database.url },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    expect(await new Promise<number | null>((resolve) => child.once('exit', resolve))).toBe(0);
    const { assetId } = JSON.parse(stdout.trim()) as { assetId: string };
    await handle.db
      .insertInto('content.encounter_topics')
      .values({
        asset_id: assetId,
        asset_revision: 1,
        topic_id: 'earth.greenhouse-effect',
        role: 'primary',
        weight: 1,
      })
      .execute();
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
      KS_OPERATOR_ACCOUNTS: 'ops@ci.invalid',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`${origin}/health`);
    const ask: CreateContentRequest = {
      version: 'content-request.v1',
      commandId: randomUUID(),
      intent: {
        kind: 'topic',
        subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: 'earth.greenhouse-effect' },
        format: 'scroll',
      },
      language: 'en',
      capabilities: textCapabilities,
    };
    const created = await fetch(`${origin}/v1/content/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(operator) },
      body: JSON.stringify(ask),
    });
    expect(created.status).toBe(200);
    requestId = ((await created.json()) as { requestId: string }).requestId;
  });
  afterAll(async () => {
    try {
      if (api !== undefined) {
        expect(await api.stop()).toBe(0);
        expect(api.records.filter((record) => record.event === 'http.unexpected_error')).toEqual([]);
      }
    } finally {
      try {
        if (handle !== undefined) await handle.close();
      } finally {
        if (database !== undefined) await database.drop();
      }
    }
  });

  const routes = () => ['/v1/operator/panels', `/v1/operator/journeys/${requestId}`];

  it('refuses without a session, as every /v1 route does', async () => {
    for (const path of routes()) await expectProblem(await get(path), 401, 'UNAUTHENTICATED');
  });

  it('answers 404 to a signed-in account that is not an operator, on every operator route', async () => {
    for (const who of [stranger, nameless])
      for (const path of routes()) await expectProblem(await get(path, who), 404, 'NOT_FOUND');
    // What they send makes no difference: a malformed ID is no reason to answer differently.
    for (const who of [stranger, nameless])
      for (const id of ['not-a-uuid', 'x'.repeat(200)])
        await expectProblem(await get(`/v1/operator/journeys/${id}`, who), 404, 'NOT_FOUND');
    const refusals = api.records.filter((record) => record.event === 'operator.refused');
    expect(refusals).toHaveLength(8);
    expect(refusals[0]).toMatchObject({ route: '/v1/operator/panels', reasonCode: 'not_operator', level: 'warn' });
    expect(refusals.every((record) => record['rejectedFields'] === undefined)).toBe(true);
  });

  it('gives an operator the panels, in the shape of the contract and with no private text', async () => {
    const response = await get('/v1/operator/panels', operator);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const panels = OperatorPanelsSchema.parse(await response.json());
    expect(panels.overview.queues.status).toBe('available');
    expect(panels.overview.requestLatency).toEqual({ status: 'unavailable', reason: 'no_tier0_source' });
    expect(panels.realtime.delivery.status).toBe('unavailable');
  });

  it("gives an operator a record's journey, and 404 for an ID nothing carries", async () => {
    const response = await get(`/v1/operator/journeys/${requestId}`, operator);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subject: 'request',
      subjectId: requestId,
      steps: [expect.objectContaining({ stage: 'supply.request', scope: 'personal' })],
    });
    await expectProblem(await get(`/v1/operator/journeys/${randomUUID()}`, operator), 404, 'NOT_FOUND');
    await expectProblem(await get('/v1/operator/journeys/not-a-uuid', operator), 400, 'INVALID_REQUEST');
  });
});
