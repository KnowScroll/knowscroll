/** Actions-only installed API/worker + disposable PostgreSQL; authored fixture, no provider. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  ClearExplorationAcceptanceSchema,
  ClearExplorationStatusSchema,
  PrivacyProblemSchema,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedKeepFixture, seedKeepSessions, type KeepFixture } from '../support/keep-fixture.js';

const path = '/v1/privacy/clear-exploration';
const canary = 'PRIVATE-CLEAR-BODY-CANARY';
describe('durable Clear through installed HTTP and normal worker', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let db: DatabaseHandle<Database>, api: ReleaseProcess, worker: ReleaseProcess | undefined, origin: string;
  const secrets = new Set<string>();
  type Fixture = KeepFixture & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };
  async function fixture(): Promise<Fixture> {
    const f = await seedKeepFixture(db.db, 'reel');
    const tokens = await seedKeepSessions(db.db, f.person);
    secrets.add(tokens.web);
    secrets.add(tokens.native);
    await db.db
      .insertInto('experience.saved_places')
      .values({
        universe_id: f.person.universeId,
        saved_entry_id: f.entry.savedEntryId,
        place_revision: 1,
        position: JSON.stringify({ kind: 'reel', positionMs: 12.5 }),
      })
      .execute();
    return { ...f, tokens };
  }
  const headers = (f: Fixture, epoch = 1, web = false): Record<string, string> => ({
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    ...(web
      ? { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.web}`, origin }
      : { authorization: `Bearer ${f.tokens.native}` }),
  });
  const command = (epoch = 1) => ({
    version: 'clear-exploration.v1',
    commandId: randomUUID(),
    expectedPrivacyEpoch: epoch,
    confirmation: 'clear-exploration-preserve-keep-and-social',
  });
  const post = (route: string, body: unknown, h: Record<string, string>) =>
    fetch(origin + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  async function status(f: Fixture, epoch: number, commandId?: string) {
    const r = await post(
      path + '/status',
      {
        version: 'clear-exploration.v1',
        target: commandId === undefined ? { kind: 'latest' } : { kind: 'command', commandId },
      },
      headers(f, epoch),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    return ClearExplorationStatusSchema.parse(await r.json());
  }
  async function accept(r: Response) {
    expect(r.status).toBe(202);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    return ClearExplorationAcceptanceSchema.parse(await r.json());
  }
  async function refusal(r: Response, code: string) {
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = PrivacyProblemSchema.parse(await r.json());
    expect(body.code).toBe(code);
    expect(r.status).toBe(body.status);
    expect(JSON.stringify(body)).not.toContain(canary);
  }
  async function saved(f: Fixture) {
    return {
      items: await db.db
        .selectFrom('experience.saved_items')
        .selectAll()
        .where('universe_id', '=', f.person.universeId)
        .execute(),
      places: await db.db
        .selectFrom('experience.saved_places')
        .selectAll()
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    };
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('privacy_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-privacy-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_BODY_LIMIT_BYTES: '4096',
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(origin + '/health');
  });
  afterAll(async () => {
    try {
      if (worker) expect(await worker.stop()).toBe(0);
      if (api) expect(await api.stop()).toBe(0);
      for (const process of [api, worker])
        if (process) {
          for (const secret of secrets) expect(process.rawOutput()).not.toContain(secret);
          expect(process.rawOutput()).not.toContain(canary);
          expect(process.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
        }
    } finally {
      await db?.close();
      await database?.drop();
    }
  });
  it('status is read-only and strict preparse/auth/Origin/scope errors remain private', async () => {
    const f = await fixture(),
      input = command();
    expect(await status(f, 1)).toMatchObject({ status: 'not_recorded' });
    await refusal(await post(path, input, {}), 'UNAUTHENTICATED');
    await refusal(
      await post(path, input, { ...headers(f, 1, true), origin: 'https://foreign.invalid' }),
      'ORIGIN_NOT_ALLOWED',
    );
    await refusal(await post(path, input, headers(f, 2)), 'SCOPE_MISMATCH');
    await refusal(await post(path, { ...input, [canary]: canary }, headers(f)), 'INVALID_REQUEST');
    await refusal(
      await fetch(origin + path, {
        method: 'POST',
        headers: { ...headers(f), 'content-type': 'application/json' },
        body: `{"${canary}":`,
      }),
      'INVALID_REQUEST',
    );
    await refusal(
      await fetch(origin + path, {
        method: 'POST',
        headers: { ...headers(f), 'content-type': 'text/plain' },
        body: canary,
      }),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    await refusal(await post(path, { [canary]: 'x'.repeat(5000) }, headers(f)), 'PAYLOAD_TOO_LARGE');
    expect(await db.db.selectFrom('identity.clear_operations').selectAll().execute()).toEqual([]);
  });
  it('202 advances epoch once with required work; ordinary reads fence while status and replay remain available', async () => {
    const f = await fixture(),
      input = command(),
      before = await saved(f);
    const first = await accept(await post(path, input, headers(f, 1, true)));
    expect(first).toMatchObject({ fromEpoch: 1, toEpoch: 2, replayed: false, commandId: input.commandId });
    const root = await db.db
      .selectFrom('identity.universes')
      .select(['privacy_epoch', 'clear_operation_id'])
      .where('id', '=', f.person.universeId)
      .executeTakeFirstOrThrow();
    expect(root.privacy_epoch).toBe(2);
    expect(root.clear_operation_id).not.toBeNull();
    const work = await sql<{ data: unknown }>`select data from pgboss.job where name='identity.clear-exploration'
      and data->>'commandId'=${input.commandId}`.execute(db.db);
    expect(work.rows).toEqual([{ data: { v: 1, accountId: f.person.accountId, commandId: input.commandId } }]);
    await refusal(await post(path, input, headers(f)), 'SCOPE_MISMATCH');
    expect(await accept(await post(path, input, headers(f, 2)))).toEqual({ ...first, replayed: true });
    expect(await status(f, 2, input.commandId)).toMatchObject({ status: 'pending', phase: 'removing_live_data' });
    const ordinary = await fetch(origin + '/v1/saved', { headers: headers(f, 2) });
    expect(ordinary.status).toBe(403);
    expect(await saved(f)).toEqual(before);
  });
  it('normal worker completes selective cleanup, preserves Saved/place, and historical replay cannot erase fresh actions', async () => {
    const f = await fixture(),
      input = command(),
      before = await saved(f);
    const first = await accept(await post(path, input, headers(f)));
    worker = startReleaseProcess('worker', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_REASONING_PROVIDER: 'none',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await worker.waitForEvent('process.started');
    await expect
      .poll(async () => (await status(f, 2, input.commandId)).status, { timeout: 20000 })
      .toBe('completed_live');
    expect(await saved(f)).toEqual(before);
    expect(
      await db.db
        .selectFrom('experience.exposures')
        .select('id')
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toEqual([]);
    const action = await post('/v1/actions', { commandId: randomUUID(), kind: 'like', target: f.ref }, headers(f, 2));
    expect(action.status).toBe(200);
    const fresh = await db.db
      .selectFrom('experience.actions')
      .selectAll()
      .where('universe_id', '=', f.person.universeId)
      .execute();
    expect(fresh).toHaveLength(1);
    expect(await accept(await post(path, input, headers(f, 2)))).toEqual({ ...first, replayed: true });
    expect(
      await db.db.selectFrom('experience.actions').selectAll().where('universe_id', '=', f.person.universeId).execute(),
    ).toEqual(fresh);
    expect(await status(f, 2)).toMatchObject({
      status: 'completed_live',
      scope: { accountId: f.person.accountId, privacyEpoch: 2 },
    });
  });
});
