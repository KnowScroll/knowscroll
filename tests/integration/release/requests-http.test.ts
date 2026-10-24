import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVELOPMENT_SESSION_COOKIE_NAME, type CreateContentRequest } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { apiClient } from '../support/api-client.js';
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

/** Built Nest API + real PostgreSQL, disposable CI bearer callers and authored starter content.
 * No worker or provider runs. Fixture topic routing is not trusted semantic coverage or live supply. */
describe('private Supply HTTP boundary in the installed release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let origin: string;
  let person: FixturePerson;
  let stranger: FixturePerson;
  let assetId: string;
  const privateCanary = 'CI private request prose must never reach diagnostics';
  const headers = (who = person, epoch = 1) => ({
    authorization: `Bearer test.${who.accountId}`,
    'x-ks-scope': `${who.accountId}:${epoch}`,
  });
  const client = (who = person, epoch = 1) =>
    apiClient(origin, headers(who).authorization, `${who.accountId}:${epoch}`);
  const command = (
    topicId = 'earth.greenhouse-effect',
    format: 'scroll' | 'reel' | 'either' = 'scroll',
  ): CreateContentRequest => ({
    version: 'content-request.v1',
    commandId: randomUUID(),
    intent: { kind: 'topic', subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId }, format },
    language: 'en',
    capabilities: textCapabilities,
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
    const body = (await response.json()) as unknown;
    expect(body).toMatchObject({ status, code });
    return body;
  }
  async function snapshot(who: FixturePerson) {
    const [requests, receipts, jobs, universe, exposures] = await Promise.all([
      handle.db
        .selectFrom('supply.requests')
        .selectAll()
        .where('universe_id', '=', who.universeId)
        .orderBy('id')
        .execute(),
      handle.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', who.universeId)
        .orderBy('command_id')
        .execute(),
      sql`select name,data from pgboss.job where data->>'universeId'=${who.universeId} order by id`.execute(handle.db),
      handle.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', who.universeId)
        .executeTakeFirstOrThrow(),
      handle.db.selectFrom('experience.exposures').select('id').where('universe_id', '=', who.universeId).execute(),
    ]);
    return { requests, receipts, jobs: jobs.rows, universe, exposures };
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('release_requests');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'requests-http-fixture', poolMax: 3, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    person = await seedPerson(handle.db);
    stranger = await seedPerson(handle.db);
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
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    expect(await new Promise<number | null>((resolve) => child.once('exit', resolve))).toBe(0);
    expect(
      stderr
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      expect.objectContaining({ schemaVersion: 'diagnostic.v1', event: 'content.scroll_admitted', outcome: 'created' }),
    ]);
    const imported = JSON.parse(stdout.trim()) as { outcome: string; assetId: string; revision: number };
    expect(imported).toMatchObject({ outcome: 'created', revision: 1 });
    assetId = imported.assetId;
    // Explicit routing-only fixture, as in the Supply module fixture. No semantic map admission.
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
      KS_BODY_LIMIT_BYTES: '4096',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
      // Create may start production for a request that no admitted content serves (D-037).
      KS_SUPPLY_CREATE_DAILY_CAP: '20',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`${origin}/health`);
  });
  afterAll(async () => {
    try {
      if (api !== undefined) {
        expect(await api.stop()).toBe(0);
        expect(api.rawOutput()).not.toContain(privateCanary);
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

  it('registers exact methods/paths and preserves global origin, auth, scope, JSON and strict-input guards without effects', async () => {
    const before = await snapshot(person);
    const c = command();
    await expectProblem(await post('/v1/content/requests', c, {}), 401, 'UNAUTHENTICATED');
    await expectProblem(
      await post('/v1/content/requests', c, { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=fixture-not-a-session` }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    await expectProblem(
      await post('/v1/content/requests', c, { authorization: headers().authorization }),
      409,
      'SCOPE_MISMATCH',
    );
    await expectProblem(
      await post('/v1/content/requests', c, { ...headers(), origin: 'https://foreign.invalid' }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    await expectProblem(
      await post(
        '/v1/content/requests/cancel',
        { version: 'content-request-cancel.v1', commandId: randomUUID(), requestId: randomUUID() },
        { ...headers(), origin: 'https://foreign.invalid' },
      ),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    await expectProblem(
      await post('/v1/content/requests', { ...c, accountId: person.accountId }),
      400,
      'INVALID_REQUEST',
    );
    await expectProblem(await post('/v1/content/requests', { ...c, commandId: 'bad' }), 400, 'INVALID_REQUEST');
    await expectProblem(
      await post('/v1/content/requests', { ...c, commandId: 'bad' }, { ...headers(), origin }),
      400,
      'INVALID_REQUEST',
    );
    await expectProblem(
      await post('/v1/content/requests/cancel', {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: randomUUID(),
        accountId: person.accountId,
      }),
      400,
      'INVALID_REQUEST',
    );
    await expectProblem(
      await fetch(`${origin}/v1/content/requests/not-a-uuid`, { headers: headers() }),
      400,
      'INVALID_REQUEST',
    );
    await expectProblem(
      await post('/v1/content/requests', { ...c, padding: 'x'.repeat(5000) }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    await expectProblem(
      await fetch(`${origin}/v1/content/requests`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'text/plain' },
        body: 'private',
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    await expectProblem(
      await fetch(`${origin}/v1/content/requests`, { method: 'PUT', headers: headers() }),
      404,
      'NOT_FOUND',
    );
    await expectProblem(
      await fetch(`${origin}/v1/content/requests/${randomUUID()}`, { headers: {} }),
      401,
      'UNAUTHENTICATED',
    );
    expect(await snapshot(person)).toEqual(before);
  });

  it('returns immutable acceptance separately from current exact ready reuse, never activates or enqueues on polling', async () => {
    const c = command();
    const accepted = await client().supply.create(c);
    expect(accepted).toMatchObject({
      version: 'content-request-receipt.v1',
      commandId: c.commandId,
      outcome: 'accepted',
      privacyEpoch: 1,
      replayed: false,
    });
    const ready = await client().supply.read({ requestId: accepted.requestId });
    expect(ready).toMatchObject({ status: 'ready', content: { assetId, assetRevision: 1 }, requestRevision: 1 });
    const before = await snapshot(person);
    for (let n = 0; n < 3; n++) expect(await client().supply.read({ requestId: accepted.requestId })).toEqual(ready);
    expect(await snapshot(person)).toEqual(before);
    expect(before.jobs).toEqual([]);
    expect(before.exposures).toEqual([]);
    await handle.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', assetId).execute();
    expect(await client().supply.read({ requestId: accepted.requestId })).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
      requestRevision: 2,
    });
    expect(await client().supply.create(c)).toEqual({ ...accepted, replayed: true });
    await handle.db.updateTable('content.assets').set({ status: 'admitted' }).where('id', '=', assetId).execute();
    expect(await client().supply.read({ requestId: accepted.requestId })).toMatchObject({
      status: 'ready',
      content: { assetId, assetRevision: 1 },
      requestRevision: 3,
    });
    expect(
      await client().supply.cancel({
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: accepted.requestId,
      }),
    ).toMatchObject({ outcome: 'already_closed' });
    expect(await client().supply.create(c)).toEqual({ ...accepted, replayed: true });
  });

  it('cancels only its private waiter, replays cancellation and rejects command-key reuse', async () => {
    const c = command('earth.tides', 'scroll');
    const a = await client().supply.create(c);
    const b = await client(stranger).supply.create({ ...c, commandId: randomUUID() });
    expect(await client().supply.read({ requestId: a.requestId })).toMatchObject({
      status: 'preparing',
      phase: 'preparing',
    });
    const before = await snapshot(person);
    for (let n = 0; n < 3; n++) await client().supply.read({ requestId: a.requestId });
    expect(await snapshot(person)).toEqual(before);
    const cancellation = {
      version: 'content-request-cancel.v1' as const,
      commandId: randomUUID(),
      requestId: a.requestId,
    };
    const cancelled = await client().supply.cancel(cancellation);
    expect(cancelled).toMatchObject({
      version: 'content-request-cancel-receipt.v1',
      outcome: 'cancelled',
      replayed: false,
    });
    expect(await client().supply.cancel(cancellation)).toEqual({ ...cancelled, replayed: true });
    expect(await client().supply.read({ requestId: a.requestId })).toMatchObject({ status: 'cancelled' });
    expect(await client(stranger).supply.read({ requestId: b.requestId })).toMatchObject({
      status: 'preparing',
      phase: 'preparing',
    });
    expect(await client().supply.create(c)).toEqual({ ...a, replayed: true });
    await expectProblem(await post('/v1/content/requests', { ...c, language: 'fr' }), 422, 'COMMAND_KEY_REUSED');
    await expectProblem(
      await post('/v1/content/requests/cancel', { ...cancellation, requestId: b.requestId }),
      422,
      'COMMAND_KEY_REUSED',
    );
    const work = await handle.db
      .selectFrom('supply.requests')
      .select('work_id')
      .where('id', 'in', [a.requestId, b.requestId])
      .execute();
    expect(work[0]?.work_id).not.toBeNull();
    expect(new Set(work.map((r) => r.work_id)).size).toBe(1);
    const shared = await handle.db
      .selectFrom('supply.work')
      .select(['active', 'production_recipe'])
      .where('id', '=', work[0]!.work_id!)
      .executeTakeFirstOrThrow();
    expect(shared).toEqual({ active: true, production_recipe: 'tides' });
  });

  it('makes foreign and unknown request reads/cancels identical without private effects', async () => {
    const receipt = await client().supply.create(command());
    const before = await snapshot(stranger);
    const foreign = await expectProblem(
      await fetch(`${origin}/v1/content/requests/${receipt.requestId}`, { headers: headers(stranger) }),
      404,
      'NOT_FOUND',
    );
    const unknown = await expectProblem(
      await fetch(`${origin}/v1/content/requests/${randomUUID()}`, { headers: headers(stranger) }),
      404,
      'NOT_FOUND',
    );
    expect(foreign).toEqual(unknown);
    const cancel = { version: 'content-request-cancel.v1', commandId: randomUUID(), requestId: receipt.requestId };
    const foreignCancel = await expectProblem(
      await post('/v1/content/requests/cancel', cancel, headers(stranger)),
      404,
      'NOT_FOUND',
    );
    const unknownCancel = await expectProblem(
      await post('/v1/content/requests/cancel', { ...cancel, requestId: randomUUID() }, headers(stranger)),
      404,
      'NOT_FOUND',
    );
    expect(foreignCancel).toEqual(unknownCancel);
    const retry = {
      version: 'content-request-retry.v1' as const,
      commandId: randomUUID(),
      requestId: receipt.requestId,
    };
    const foreignRetry = await expectProblem(
      await post('/v1/content/requests/retry', retry, headers(stranger)),
      404,
      'NOT_FOUND',
    );
    const unknownRetry = await expectProblem(
      await post('/v1/content/requests/retry', { ...retry, requestId: randomUUID() }, headers(stranger)),
      404,
      'NOT_FOUND',
    );
    expect(foreignRetry).toEqual(unknownRetry);
    // The owner's own request is still preparing, so a retry changes nothing and says so.
    expect(await client().supply.retry({ ...retry, commandId: randomUUID() })).toMatchObject({
      version: 'content-request-retry-receipt.v1',
      outcome: 'already_open',
      requestId: receipt.requestId,
    });
    expect(await snapshot(stranger)).toEqual(before);
  });

  it('closes an ask no match can serve at once, and keeps a free-text ask private while it waits to be matched', async () => {
    const p = await seedPerson(handle.db);
    const french: CreateContentRequest = {
      ...command(),
      intent: { kind: 'topic', subject: { kind: 'text', text: privateCanary }, format: 'scroll' },
      language: 'fr',
    };
    const closed = await client(p).supply.create(french);
    expect(await client(p).supply.read({ requestId: closed.requestId })).toMatchObject({
      status: 'unavailable',
      reason: 'unsupported_request',
    });
    expect((await snapshot(p)).jobs).toEqual([]);

    const free: CreateContentRequest = {
      ...command(),
      intent: { kind: 'topic', subject: { kind: 'text', text: privateCanary }, format: 'scroll' },
    };
    const receipt = await client(p).supply.create(free);
    expect(await client(p).supply.read({ requestId: receipt.requestId })).toMatchObject({
      status: 'preparing',
      phase: 'requested',
    });
    // The queued job names the request by ID; the words are in the private row only.
    const state = await snapshot(p);
    expect(state.jobs).toHaveLength(1);
    expect(JSON.stringify(state.jobs)).not.toContain(privateCanary);
    expect(state.exposures).toEqual([]);
    expect(await client(p).supply.create(free)).toEqual({ ...receipt, replayed: true });
  });

  it('lists the person own asks newest first with a title, never another person ask', async () => {
    const p = await seedPerson(handle.db),
      other = await seedPerson(handle.db);
    const first = await client(p).supply.create(command('earth.seasons', 'scroll'));
    await client(other).supply.create(command('earth.tides', 'scroll'));
    const second = await client(p).supply.create({
      ...command(),
      intent: { kind: 'topic', subject: { kind: 'text', text: 'How do whales sleep?' }, format: 'either' },
    });
    const listed = await client(p).supply.list();
    expect(listed).toMatchObject({ version: 'content-request-list.v1' });
    expect(listed.requests.map((r) => [r.title, r.format, r.status.requestId])).toEqual([
      ['How do whales sleep?', 'either', second.requestId],
      ['Seasons', 'scroll', first.requestId],
    ]);
    expect(JSON.stringify(listed)).not.toContain('Tides');
    await expectProblem(await fetch(`${origin}/v1/content/requests`, { headers: {} }), 401, 'UNAUTHENTICATED');
    await expectProblem(
      await fetch(`${origin}/v1/content/requests`, { headers: headers(p, 2) }),
      409,
      'SCOPE_MISMATCH',
    );
  });

  it('fences stale scope before read/create/cancel and keeps old-epoch requests hidden after reset', async () => {
    const p = await seedPerson(handle.db);
    const receipt = await client(p).supply.create(command('earth.tides', 'reel'));
    await handle.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', p.universeId)
      .execute();
    const before = await snapshot(p);
    await expectProblem(
      await fetch(`${origin}/v1/content/requests/${receipt.requestId}`, { headers: headers(p) }),
      409,
      'SCOPE_MISMATCH',
    );
    await expectProblem(await post('/v1/content/requests', command(), headers(p)), 409, 'SCOPE_MISMATCH');
    await expectProblem(
      await post(
        '/v1/content/requests/cancel',
        { version: 'content-request-cancel.v1', commandId: randomUUID(), requestId: receipt.requestId },
        headers(p),
      ),
      409,
      'SCOPE_MISMATCH',
    );
    await expectProblem(
      await fetch(`${origin}/v1/content/requests/${receipt.requestId}`, { headers: headers(p, 2) }),
      404,
      'NOT_FOUND',
    );
    expect(await snapshot(p)).toEqual(before);
  });
});
