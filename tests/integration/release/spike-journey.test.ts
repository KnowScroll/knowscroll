import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScopeChangedHintSchema, SOCKET_PATH, socketEvents, type ScopeChangedHint } from '@knowscroll/contracts';
import { revokeAccountSockets } from '@knowscroll/backend/infrastructure/notices';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { quoteIdentifier, withAdmin } from '../support/admin.js';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedAsset, seedPerson, type FixturePerson } from '../support/fixtures.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';

/**
 * The S1.2 spike journey through the deployed release trees: HTTP command → locked receipt +
 * saved item + pg-boss job + revision bump and NOTIFY in one transaction → API relay → Socket.IO
 * `scope_changed` → HTTP catch-up read; the worker job then writes evidence (which changes nothing
 * a client reads, so it sends no hint).
 *
 * Evidence label: CI fixture + real database. Accounts, universes and assets are fixtures (S1.3
 * adds sign-up, Phase 2 adds admitted content); callers are authenticated by the test-only
 * adapter, which the production configuration refuses.
 */
/** Fixture AgentMail settings (never used to send: these processes are refused or test-bearer only). */
const fixtureAgentMail = { AGENTMAIL_API_KEY: 'fixture-not-a-key', AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid' };

const canaries = {
  token: 'canary-query-token-Hx81',
  password: 'canary-query-password-Jy92',
  bearer: 'canary-bearer-Kz03',
  cookie: 'canary-cookie-Lw14',
  chat: 'CANARY CHAT BODY meet me later',
} as const;

describe('the spike journey through the built API, worker and Socket.IO', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let worker: ReleaseProcess;
  let baseUrl: string;
  let person: FixturePerson;
  let stranger: FixturePerson;
  let asset: { readonly assetId: string; readonly revision: number };
  const sockets: Socket[] = [];

  beforeAll(async () => {
    database = await createEmptyDatabase('release_spike');
    const migrate = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await migrate.exited()).toBe(0);
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'knowscroll-it-fixtures', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    person = await seedPerson(handle.db);
    stranger = await seedPerson(handle.db);
    asset = await seedAsset(handle.db);

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const shared = { NODE_ENV: 'test', KS_WORLD: 'ci', DATABASE_URL: database.url, KS_SHUTDOWN_GRACE_SECONDS: '10' };
    // This journey authenticates with the CI-only test-bearer adapter; sign-in itself is proved by
    // identity-journey.test.ts. The fixture mail sender is never used here.
    const fixtureMail = { KS_MAIL_SENDER: 'fixture' };
    // KS_SOCKET_AUTH_CACHE_MS=0: every relayed hint re-reads access, so revocation shows at once.
    api = startReleaseProcess('api', 'main', {
      ...shared,
      PORT: String(port),
      ...fixtureMail,
      KS_AUTH_ADAPTER: 'test-bearer',
      KS_BODY_LIMIT_BYTES: '2048',
      KS_SOCKET_AUTH_CACHE_MS: '0',
    });
    worker = startReleaseProcess('worker', 'main', shared);
    await Promise.all([api.waitForEvent('process.started'), worker.waitForEvent('process.started')]);
    await waitForHttp(`${baseUrl}/health`);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await handle.close();
    await database.drop();
  });

  function connect(token: string): Socket {
    const socket = io(baseUrl, { path: SOCKET_PATH, transports: ['websocket'], auth: { token }, reconnection: false });
    sockets.push(socket);
    return socket;
  }

  async function connected(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  }

  it('reports the relay as listening in /health', async () => {
    expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({
      status: 'ok',
      world: 'ci',
      relay: 'listening',
    });
  });

  it('saves an item, hints the subscriber for the command and again after the worker applies evidence, and the catch-up read shows it', async () => {
    const socket = connect(`test.${person.accountId}`);
    const hints: ScopeChangedHint[] = [];
    socket.on(socketEvents.scopeChanged, (hint: unknown) => hints.push(ScopeChangedHintSchema.parse(hint)));
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: person.universeId } }),
    ).toEqual({ ok: true, revision: 0 });

    const client = apiClient(baseUrl, `Bearer test.${person.accountId}`);
    const commandId = randomUUID();
    const saved = await client.experience.applyAction({
      commandId,
      kind: 'save',
      target: { assetId: asset.assetId, assetRevision: asset.revision },
    });
    expect(saved).toMatchObject({
      commandId,
      kind: 'save',
      assetId: asset.assetId,
      saved: true,
      changed: true,
      revision: 1,
      replayed: false,
    });

    // Revision 1 is the command's own commit. The evidence job changes nothing a client reads.
    await expect.poll(() => hints.map((hint) => hint.revision), { timeout: 20_000 }).toEqual([1]);
    expect(hints.every((hint) => hint.scope.id === person.universeId)).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await handle.db
              .selectFrom('evidence.action_events')
              .select('id')
              .where('universe_id', '=', person.universeId)
              .execute()
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1);
    const list = await client.experience.listSaved({});
    expect(list.revision).toBe(1);
    expect(list.items).toEqual([expect.objectContaining({ assetId: asset.assetId, assetRevision: asset.revision })]);

    // A retried command returns the stored outcome and causes no second effect or hint.
    const replay = await client.experience.applyAction({
      commandId,
      kind: 'save',
      target: { assetRevision: asset.revision, assetId: asset.assetId },
    });
    expect(replay).toEqual({ ...saved, replayed: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(hints).toHaveLength(1);
    const evidence = await handle.db
      .selectFrom('evidence.action_events')
      .select('id')
      .where('universe_id', '=', person.universeId)
      .execute();
    expect(evidence).toHaveLength(1);
  });

  it('answers refusals as RFC 9457 problems with stable codes', async () => {
    const post = (
      body: unknown,
      headers: Record<string, string> = { authorization: `Bearer test.${person.accountId}` },
    ) =>
      fetch(`${baseUrl}/v1/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const expectProblem = async (response: Response, status: number, code: string) => {
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect({ status: response.status, body: (await response.json()) as unknown }).toEqual({
        status,
        body: expect.objectContaining({ status, code }) as unknown,
      });
    };
    const commandId = randomUUID();
    const save = { commandId, kind: 'save', target: { assetId: asset.assetId, assetRevision: asset.revision } };
    expect((await post(save)).status).toBe(200);
    await expectProblem(await post({ ...save, kind: 'unsave' }), 422, 'COMMAND_KEY_REUSED');
    await expectProblem(
      await post({ ...save, commandId: randomUUID(), target: { assetId: randomUUID(), assetRevision: 1 } }),
      404,
      'ASSET_NOT_FOUND',
    );
    await expectProblem(
      await post({ ...save, commandId: randomUUID(), target: { assetId: asset.assetId, assetRevision: 2 } }),
      409,
      'ASSET_REVISION_STALE',
    );
    await expectProblem(await post(save, {}), 401, 'UNAUTHENTICATED');
    await expectProblem(await post({ commandId: 'not-a-uuid', kind: 'like' }), 400, 'INVALID_REQUEST');
    await expectProblem(await post({ ...save, padding: 'x'.repeat(4096) }), 413, 'PAYLOAD_TOO_LARGE');
    const textBody = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    await expectProblem(textBody, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('authorises every subscription against current access', async () => {
    const socket = connect(`test.${person.accountId}`);
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: stranger.universeId } }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: 'not-a-uuid' } }),
    ).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    await handle.db
      .updateTable('identity.universes')
      .set({ status: 'suspended' })
      .where('id', '=', stranger.universeId)
      .execute();
    const strangerSocket = connect(`test.${stranger.accountId}`);
    await expect(connected(strangerSocket)).rejects.toThrow('UNAUTHENTICATED');
    const anonymous = connect('not-a-token');
    await expect(connected(anonymous)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('drops a subscription whose access no longer holds when it relays the next hint', async () => {
    const owner = await seedPerson(handle.db);
    const socket = connect(`test.${owner.accountId}`);
    const changed: ScopeChangedHint[] = [];
    const revoked: unknown[] = [];
    socket.on(socketEvents.scopeChanged, (hint: unknown) => changed.push(ScopeChangedHintSchema.parse(hint)));
    socket.on(socketEvents.scopeRevoked, (hint: unknown) => revoked.push(hint));
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: owner.universeId } }),
    ).toEqual({ ok: true, revision: 0 });
    // A privacy reset elsewhere: the socket's authorisation (epoch 1) no longer holds.
    await handle.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', owner.universeId)
      .execute();
    const client = apiClient(baseUrl, `Bearer test.${owner.accountId}`);
    await client.experience.applyAction({
      commandId: randomUUID(),
      kind: 'save',
      target: { assetId: asset.assetId, assetRevision: asset.revision },
    });
    await expect
      .poll(() => revoked, { timeout: 20_000 })
      .toEqual([{ scope: { kind: 'universe', id: owner.universeId } }]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(changed).toEqual([]);
  });

  it('disconnects every socket of an account when its access is revoked', async () => {
    const owner = await seedPerson(handle.db);
    const socket = connect(`test.${owner.accountId}`);
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: owner.universeId } }),
    ).toEqual({ ok: true, revision: 0 });
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    await handle.db.transaction().execute((trx) => revokeAccountSockets(trx, owner.accountId));
    expect(await disconnected).toBe('io server disconnect');
  });

  it('makes every socket authenticate again after a relay reconnect, so a revocation lost meanwhile still applies', async () => {
    const owner = await seedPerson(handle.db);
    const socket = connect(`test.${owner.accountId}`);
    const reasons: string[] = [];
    socket.on('disconnect', (reason) => reasons.push(reason));
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: owner.universeId } }),
    ).toEqual({ ok: true, revision: 0 });
    // Opened before the outage: the only connection that can send the revocation while it lasts.
    const sender = new pg.Client({ connectionString: database.url, application_name: 'knowscroll-it-revoker' });
    await sender.connect();
    const relayBackends = async () =>
      withAdmin(async (client) => {
        const result = await client.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = 'knowscroll-api-ci-relay'",
          [database.name],
        );
        return result.rows[0]?.n ?? 0;
      });
    try {
      // The relay's connection is cut and cannot come back: the API is deaf to notices.
      await withAdmin(async (client) => {
        await client.query(`alter database ${quoteIdentifier(database.name)} with allow_connections false`);
        await client.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = 'knowscroll-api-ci-relay'",
          [database.name],
        );
      });
      await expect.poll(relayBackends, { timeout: 10_000 }).toBe(0);
      // Sign-out / session revocation in S1.3 sends this notice; no relay hears it.
      await sender.query('select pg_notify($1, $2)', [
        'ks_access_revoked',
        JSON.stringify({ v: 1, accountId: owner.accountId }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(socket.connected).toBe(true);
    } finally {
      await withAdmin((client) =>
        client.query(`alter database ${quoteIdentifier(database.name)} with allow_connections true`),
      );
      await sender.end();
    }
    // The relay is back: before relaying anything it closes every socket, so the client must
    // reconnect and authenticate again (S1.3: a revoked session is refused there).
    await expect.poll(() => reasons, { timeout: 20_000 }).toEqual(['transport close']);
    await expect.poll(relayBackends, { timeout: 10_000 }).toBe(1);
    await expect
      .poll(async () => ((await (await fetch(`${baseUrl}/health`)).json()) as { relay?: string }).relay, {
        timeout: 10_000,
      })
      .toBe('listening');
  });

  it('never writes secrets from URLs, headers or bodies to its output', async () => {
    await fetch(`${baseUrl}/v1/saved?token=${canaries.token}&password=${canaries.password}`, {
      headers: { authorization: `Bearer ${canaries.bearer}`, cookie: `session=${canaries.cookie}` },
    });
    await fetch(`${baseUrl}/v1/actions?token=${canaries.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer test.${person.accountId}` },
      body: JSON.stringify({
        commandId: randomUUID(),
        kind: 'save',
        target: { assetId: canaries.chat, assetRevision: 1 },
      }),
    });
    await fetch(`${baseUrl}/no-route/${canaries.token}?password=${canaries.password}`);
    const output = api.rawOutput() + worker.rawOutput();
    for (const value of Object.values(canaries)) expect(output.includes(value)).toBe(false);
    expect(output.includes(database.url)).toBe(false);
  });

  it('stops the API and worker cleanly on SIGTERM', async () => {
    for (const socket of sockets) socket.close();
    const [apiExit, workerExit] = await Promise.all([api.stop('SIGTERM'), worker.stop('SIGTERM')]);
    expect({ apiExit, workerExit }).toEqual({ apiExit: 0, workerExit: 0 });
  });
});

describe('the test-only caller adapter outside CI', () => {
  it('is refused in a dev world even with NODE_ENV=test', async () => {
    const database = await createEmptyDatabase('release_refuse_world');
    try {
      const api = startReleaseProcess('api', 'main', {
        NODE_ENV: 'test',
        KS_WORLD: 'dev',
        DATABASE_URL: database.url,
        PORT: String(await freePort()),
        ...fixtureAgentMail,
        KS_AUTH_ADAPTER: 'test-bearer',
      });
      expect(await api.exited()).toBe(1);
      expect(api.records).toEqual([
        expect.objectContaining({ event: 'config.invalid', problems: ['KS_AUTH_ADAPTER: refused_in_this_world'] }),
      ]);
    } finally {
      await database.drop();
    }
  });
});

describe('the production configuration', () => {
  it('refuses to start with the test-only caller adapter', async () => {
    const database = await createEmptyDatabase('release_refuse');
    const port = await freePort();
    try {
      const api = startReleaseProcess('api', 'main', {
        NODE_ENV: 'production',
        KS_WORLD: 'ci',
        KS_COMMIT: '0'.repeat(40),
        KS_ARTIFACT_SHA256: createHash('sha256').update('ci-fixture').digest('hex'),
        DATABASE_URL: database.url,
        PORT: String(port),
        KS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        ...fixtureAgentMail,
        KS_AUTH_ADAPTER: 'test-bearer',
      });
      expect(await api.exited()).toBe(1);
      expect(api.records).toEqual([
        expect.objectContaining({ event: 'config.invalid', problems: ['KS_AUTH_ADAPTER: refused_outside_test'] }),
      ]);
    } finally {
      await database.drop();
    }
  });
});
