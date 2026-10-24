/** Actions-only installed API/worker + disposable PostgreSQL; authored fixtures, no provider. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountDeletionStatusSchema,
  DELETE_ACCOUNT_CONFIRMATION,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  DataExportLinkSchema,
  ProblemDetailsSchema,
  SessionListSchema,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedKeepFixture, seedKeepSessions, type KeepFixture } from '../support/keep-fixture.js';

/**
 * Account through the installed API and the normal worker: sessions, one-time export download and
 * account deletion, with the receipt readable after every session has ended.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('account sessions, export and deletion through the installed release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let db: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let worker: ReleaseProcess;
  let origin: string;
  const secrets = new Set<string>();

  type Fixture = KeepFixture & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };
  async function fixture(): Promise<Fixture> {
    const person = await seedKeepFixture(db.db, 'reel');
    const tokens = await seedKeepSessions(db.db, person.person);
    secrets.add(tokens.web);
    secrets.add(tokens.native);
    return { ...person, tokens };
  }
  const bearer = (f: Fixture, epoch = 1) => ({
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    authorization: `Bearer ${f.tokens.native}`,
  });
  const cookie = (f: Fixture, epoch = 1) => ({
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.web}`,
    origin,
  });
  const call = (method: 'GET' | 'POST', route: string, headers: Record<string, string>, body?: unknown) =>
    fetch(origin + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  async function problemCode(response: Response): Promise<string> {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    return ProblemDetailsSchema.parse(await response.json()).code;
  }

  beforeAll(async () => {
    database = await createEmptyDatabase('account_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-account-http', poolMax: 5, statementTimeoutMs: 15000 },
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
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(origin + '/health');
    worker = startReleaseProcess('worker', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_REASONING_PROVIDER: 'none',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await worker.waitForEvent('process.started');
  });
  afterAll(async () => {
    try {
      if (worker) expect(await worker.stop()).toBe(0);
      if (api) expect(await api.stop()).toBe(0);
      for (const process of [api, worker])
        if (process) {
          for (const secret of secrets) expect(process.rawOutput()).not.toContain(secret);
          expect(process.records.filter((record) => record.event === 'http.unexpected_error')).toEqual([]);
        }
    } finally {
      await db?.close();
      await database?.drop();
    }
  });

  it('asks for the scope claim and a session on every account route', async () => {
    const f = await fixture();
    for (const [method, route] of [
      ['GET', '/v1/account/sessions'],
      ['GET', '/v1/account/exports'],
    ] as const) {
      expect(await problemCode(await call(method, route, {}))).toBe('UNAUTHENTICATED');
      expect(await problemCode(await call(method, route, bearer(f, 2)))).toBe('SCOPE_MISMATCH');
    }
  });

  it('lists the sessions and signs another one out', async () => {
    const f = await fixture();
    const listed = SessionListSchema.parse(await (await call('GET', '/v1/account/sessions', bearer(f))).json());
    expect(listed.sessions.map((session) => [session.client, session.deviceLabel, session.current]).sort()).toEqual([
      ['native', 'KnowScroll app', true],
      ['web', 'Web browser', false],
    ]);
    const web = listed.sessions.find((session) => session.client === 'web');
    const own = listed.sessions.find((session) => session.current);
    if (web === undefined || own === undefined) throw new Error('two sessions expected');
    expect(await problemCode(await call('POST', '/v1/account/sessions/end', bearer(f), { sessionId: own.id }))).toBe(
      'CONFLICT',
    );
    expect(
      await problemCode(await call('POST', '/v1/account/sessions/end', bearer(f), { sessionId: randomUUID() })),
    ).toBe('NOT_FOUND');
    const ended = await call('POST', '/v1/account/sessions/end', bearer(f), { sessionId: web.id });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ status: 'ended' });
    expect(await problemCode(await call('GET', '/v1/account/sessions', cookie(f)))).toBe('UNAUTHENTICATED');
    expect((await call('POST', '/v1/account/sessions/end-others', bearer(f))).status).toBe(200);
  });

  it('builds an export in the worker and hands it over once', async () => {
    const f = await fixture();
    const exportId = randomUUID();
    const requested = await call('POST', '/v1/account/exports', bearer(f), { exportId });
    expect(requested.status).toBe(202);
    expect(requested.headers.get('cache-control')).toBe('private, no-store');
    expect(await requested.json()).toMatchObject({ export: { id: exportId, state: 'preparing' } });
    await expect
      .poll(
        async () =>
          ((await (await call('GET', '/v1/account/exports', bearer(f))).json()) as { exports: { state: string }[] })
            .exports[0]?.state,
        { timeout: 20000 },
      )
      .toBe('ready');

    const link = DataExportLinkSchema.parse(
      await (await call('POST', '/v1/account/exports/link', bearer(f), { exportId })).json(),
    );
    // The link needs no session, scope or origin: a browser follows it.
    const file = await fetch(origin + link.path);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('application/json');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="knowscroll-export.json"');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const text = await file.text();
    const body = JSON.parse(text) as { version: string; sections: Record<string, unknown> };
    expect(body.version).toBe('knowscroll-export.v1');
    expect(JSON.stringify(body.sections['experience'])).toContain('[Fixture] Keep HTTP Reel');
    expect(text.replace(/keep-[0-9a-f-]{36}@fixture\.test/, '')).not.toMatch(UUID);
    expect(text).not.toContain(f.person.accountId);
    expect(text).not.toContain(f.person.universeId);
    // Once.
    expect(await problemCode(await fetch(origin + link.path))).toBe('NOT_FOUND');
    expect(await problemCode(await fetch(origin + '/auth/exports/kse_' + 'A'.repeat(43)))).toBe('NOT_FOUND');
    expect(await problemCode(await fetch(origin + '/auth/exports/not-a-token'))).toBe('NOT_FOUND');
    secrets.add(link.path.slice('/auth/exports/'.length));
  });

  it('deletes an account: ends the session, answers the receipt, and removes everything in the worker', async () => {
    const f = await fixture();
    const receiptId = randomUUID();
    const request = {
      receiptId,
      expectedPrivacyEpoch: 1,
      confirmation: DELETE_ACCOUNT_CONFIRMATION,
    };
    // Refused before anything changes.
    expect(
      await problemCode(await call('POST', '/v1/account/delete', cookie(f), { ...request, confirmation: 'yes' })),
    ).toBe('INVALID_REQUEST');
    expect(
      await problemCode(await call('POST', '/v1/account/delete', cookie(f), { ...request, expectedPrivacyEpoch: 2 })),
    ).toBe('PRIVACY_EPOCH_CHANGED');
    expect(await problemCode(await call('GET', `/auth/deletion/${randomUUID()}`, {}))).toBe('NOT_FOUND');
    expect(await problemCode(await call('POST', '/auth/deletion/retry', {}, { receiptId: randomUUID() }))).toBe(
      'NOT_FOUND',
    );

    const accepted = await call('POST', '/v1/account/delete', cookie(f), request);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    // The web session is over: the cookie is cleared with the answer.
    expect(accepted.headers.get('set-cookie')).toContain(`${DEVELOPMENT_SESSION_COOKIE_NAME}=;`);
    expect(await accepted.json()).toMatchObject({ receiptId });

    // Every credential is refused from now on, and the receipt needs none.
    expect(await problemCode(await call('GET', '/v1/account/sessions', bearer(f, 2)))).toBe('UNAUTHENTICATED');
    expect(await problemCode(await call('GET', '/v1/account/sessions', cookie(f, 2)))).toBe('UNAUTHENTICATED');
    await expect
      .poll(
        async () =>
          AccountDeletionStatusSchema.parse(await (await call('GET', `/auth/deletion/${receiptId}`, {})).json()).state,
        { timeout: 30000 },
      )
      .toBe('completed');
    expect(
      await problemCode(
        await call('POST', '/v1/account/delete', bearer(f, 2), {
          ...request,
          receiptId: randomUUID(),
          expectedPrivacyEpoch: 2,
        }),
      ),
    ).toBe('UNAUTHENTICATED');
    const retried = await call('POST', '/auth/deletion/retry', {}, { receiptId });
    expect(await retried.json()).toEqual({ state: 'completed' });

    expect(
      await db.db.selectFrom('identity.accounts').select('id').where('id', '=', f.person.accountId).execute(),
    ).toEqual([]);
    expect(
      await db.db
        .selectFrom('experience.saved_items')
        .select('universe_id')
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await db.db
        .selectFrom('identity.account_deletions')
        .select(['account_id', 'scope_id', 'state'])
        .where('id', '=', receiptId)
        .execute(),
    ).toEqual([{ account_id: null, scope_id: null, state: 'completed' }]);
    // Nothing the deletion wrote to a log names the person.
    for (const process of [api, worker]) {
      expect(process.rawOutput()).not.toContain(f.person.accountId);
      expect(process.rawOutput()).not.toContain(f.person.universeId);
      expect(process.rawOutput()).not.toContain(receiptId);
    }
  });
});
