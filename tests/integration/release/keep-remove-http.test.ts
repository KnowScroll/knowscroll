/** Installed actual Nest + PG + authored fixtures. No app/native/runtime/privacy completion claim. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  KeepRemovalAcceptanceSchema,
  KeepRemovalProblemSchema,
  type RemoveKeepEntry,
} from '@knowscroll/contracts';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  withTransaction,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedKeepFixture, seedKeepSessions, type KeepFixture } from '../support/keep-fixture.js';
import { seedPerson } from '../support/fixtures.js';
import { gate } from '../support/fixture-model.js';
const path = '/v1/experience/keep/remove',
  canary = 'PRIVATE-REMOVE-BODY-RECEIVED-CANARY';
describe('exact membership removal in installed HTTP release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    db: DatabaseHandle<Database>,
    other: DatabaseHandle<Database>,
    api: ReleaseProcess,
    origin: string;
  const secrets = new Set<string>();
  type Fixture = KeepFixture & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };
  async function fixture(): Promise<Fixture> {
    const f = await seedKeepFixture(db.db, 'reel'),
      tokens = await seedKeepSessions(db.db, f.person);
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    return { ...f, tokens };
  }
  const headers = (f: Fixture, client: 'native' | 'web' = 'native', epoch = 1): Record<string, string> => ({
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    ...(client === 'native'
      ? { authorization: `Bearer ${f.tokens.native}` }
      : { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.web}`, origin }),
  });
  const command = (f: Fixture): RemoveKeepEntry => ({
    version: 'keep-remove.v1',
    commandId: randomUUID(),
    entry: f.entry,
  });
  const post = (p: string, body: unknown, h: Record<string, string>) =>
    fetch(origin + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  async function accepted(r: Response) {
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    return KeepRemovalAcceptanceSchema.parse(await r.json());
  }
  async function refused(r: Response, code: string) {
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    const value = KeepRemovalProblemSchema.parse(await r.json());
    expect(value.code).toBe(code);
    expect(r.status).toBe(value.status);
    expect(JSON.stringify(value)).not.toContain(canary);
    expect(value).not.toHaveProperty('currentEntry');
    expect(value).not.toHaveProperty('currentPlaceRevision');
    return value;
  }
  async function state(f: Fixture) {
    return (
      await sql<{ value: Record<string, unknown> }>`select jsonb_build_object(
      'root',(select to_jsonb(r) from identity.universes r where id=${f.person.universeId}::uuid),
      'saved',(select coalesce(jsonb_agg(to_jsonb(r) order by asset_id),'[]'::jsonb) from experience.saved_items r where universe_id=${f.person.universeId}::uuid),
      'places',(select coalesce(jsonb_agg(to_jsonb(r) order by saved_entry_id),'[]'::jsonb) from experience.saved_places r where universe_id=${f.person.universeId}::uuid),
      'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by command_id),'[]'::jsonb) from receipts.personal_commands r where universe_id=${f.person.universeId}::uuid),
      'actions',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from experience.actions r where universe_id=${f.person.universeId}::uuid),
      'links',(select coalesce(jsonb_agg(to_jsonb(r) order by action_id),'[]'::jsonb) from experience.action_links r where universe_id=${f.person.universeId}::uuid),
      'observations',(select count(*) from evidence.observations where universe_id=${f.person.universeId}::uuid),
      'exposures',(select count(*) from experience.exposures where universe_id=${f.person.universeId}::uuid),
      'jobs',(select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]'::jsonb) from pgboss.job j where data->>'universeId'=${f.person.universeId})
    ) value`.execute(db.db)
    ).rows[0]!.value;
  }
  async function waiting() {
    return (
      await sql<{
        n: number;
      }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
        db.db,
      )
    ).rows[0]!.n;
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('keep_remove_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-remove-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    other = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-remove-barrier', poolMax: 3, statementTimeoutMs: 15000 },
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
      if (api) {
        expect(await api.stop()).toBe(0);
        expect(api.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
        for (const secret of secrets) expect(api.rawOutput()).not.toContain(secret);
        expect(api.rawOutput()).not.toContain(canary);
      }
    } finally {
      await other?.close();
      await db?.close();
      await database?.drop();
    }
  });
  it.each(['native', 'web'] as const)(
    'mounts %s authenticated removal and identical historical replay as real HTTP',
    async (client) => {
      const f = await fixture(),
        input = command(f);
      await db.db
        .insertInto('experience.saved_places')
        .values({
          universe_id: f.person.universeId,
          saved_entry_id: f.entry.savedEntryId,
          place_revision: 1,
          position: JSON.stringify({ kind: 'reel', positionMs: 1.5 }),
        })
        .execute();
      const before = await state(f),
        first = await accepted(await post(path, input, headers(f, client)));
      expect(first).toMatchObject({
        ...input,
        operation: 'keep.entry.remove',
        replayed: false,
        scope: { accountId: f.person.accountId, privacyEpoch: 1 },
      });
      const after = await state(f);
      expect(after['saved']).toEqual([]);
      expect(after['places']).toEqual([]);
      expect((after['actions'] as unknown[]).length).toBe((before['actions'] as unknown[]).length + 1);
      expect((after['jobs'] as unknown[]).length).toBe((before['jobs'] as unknown[]).length + 1);
      expect(after['observations']).toBe(before['observations']);
      expect(after['exposures']).toBe(before['exposures']);
      // First response is discarded by a caller; explicit same-body retry is the only replay.
      expect(await accepted(await post(path, input, headers(f, client)))).toEqual({ ...first, replayed: true });
      expect(await state(f)).toEqual(after);
    },
  );
  it('old A replay leaves a real legacy-resaved B/place intact; fresh A and changed-key body are closed refusals', async () => {
    const f = await fixture(),
      input = command(f),
      first = await accepted(await post(path, input, headers(f)));
    const save = await post('/v1/actions', { commandId: randomUUID(), kind: 'save', target: f.ref }, headers(f));
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ saved: true, changed: true });
    const row = await db.db
      .selectFrom('experience.saved_items')
      .selectAll()
      .where('universe_id', '=', f.person.universeId)
      .where('asset_id', '=', f.ref.assetId)
      .executeTakeFirstOrThrow();
    expect(row.saved_entry_id).not.toBe(f.entry.savedEntryId);
    await db.db
      .insertInto('experience.saved_places')
      .values({
        universe_id: f.person.universeId,
        saved_entry_id: row.saved_entry_id,
        place_revision: 1,
        position: JSON.stringify({ kind: 'reel', positionMs: 33.75 }),
      })
      .execute();
    const before = await state(f);
    expect(await accepted(await post(path, input, headers(f)))).toEqual({ ...first, replayed: true });
    await refused(await post(path, command(f), headers(f)), 'KEEP_ENTRY_UNAVAILABLE');
    await refused(
      await post(path, { ...input, entry: { ...f.entry, savedEntryId: row.saved_entry_id } }, headers(f)),
      'COMMAND_KEY_REUSED',
    );
    expect(await state(f)).toEqual(before);
  });
  it.each(['withdrawn', 'corrected'] as const)(
    'can remove a %s stored membership without any playback/admission precondition',
    async (kind) => {
      const f = await fixture();
      await db.db
        .updateTable('content.assets')
        .set(kind === 'withdrawn' ? { status: 'withdrawn' } : { revision: 2 })
        .where('id', '=', f.ref.assetId)
        .execute();
      await db.db
        .updateTable('content.asset_revisions')
        .set({ document: '{}' })
        .where('asset_id', '=', f.ref.assetId)
        .execute();
      expect(await accepted(await post(path, command(f), headers(f)))).toMatchObject({ entry: f.entry });
      expect((await state(f))['saved']).toEqual([]);
    },
  );
  it('closes auth/Origin/scope and strict input/parser failures before any mutation and never echoes private keys', async () => {
    const f = await fixture(),
      input = command(f),
      before = await state(f);
    await refused(await post(path, input, {}), 'UNAUTHENTICATED');
    await refused(
      await post(path, input, { ...headers(f, 'web'), origin: 'https://foreign.invalid' }),
      'ORIGIN_NOT_ALLOWED',
    );
    await refused(await post(path, input, headers(f, 'native', 2)), 'SCOPE_MISMATCH');
    for (const body of [
      { ...input, [canary]: canary },
      { ...input, entry: { ...f.entry, [canary]: canary } },
      { ...input, expectedPlaceRevision: 1 },
      { ...input, position: { kind: 'reel', positionMs: 1 } },
    ]) {
      const p = await refused(await post(path, body, headers(f)), 'INVALID_REQUEST');
      expect(JSON.stringify(p)).not.toContain(canary);
    }
    await refused(
      await fetch(origin + path, {
        method: 'POST',
        headers: { ...headers(f), 'content-type': 'application/json' },
        body: `{"${canary}":`,
      }),
      'INVALID_REQUEST',
    );
    await refused(
      await fetch(origin + path, {
        method: 'POST',
        headers: { ...headers(f), 'content-type': 'application/json' },
        body: JSON.stringify({ [canary]: 'x'.repeat(5000) }),
      }),
      'PAYLOAD_TOO_LARGE',
    );
    await refused(
      await fetch(origin + path, {
        method: 'POST',
        headers: { ...headers(f), 'content-type': 'text/plain' },
        body: canary,
      }),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(await state(f)).toEqual(before);
  });
  it('does not disclose another account membership, including when that account saves the same ref', async () => {
    const f = await fixture(),
      p = await seedPerson(db.db),
      tokens = await seedKeepSessions(db.db, p);
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    const otherFixture = { ...f, person: p, tokens };
    const save = await post(
      '/v1/actions',
      { commandId: randomUUID(), kind: 'save', target: f.ref },
      headers(otherFixture),
    );
    expect(save.status).toBe(200);
    const before = await state(f),
      foreignBefore = await state(otherFixture);
    await refused(await post(path, command(f), headers(otherFixture)), 'KEEP_ENTRY_UNAVAILABLE');
    expect(await state(f)).toEqual(before);
    expect(await state(otherFixture)).toEqual(foreignBefore);
  });
  it('serializes actual duplicate commands to one action/job and an immutable ACK pair', async () => {
    const f = await fixture(),
      input = command(f),
      before = await state(f);
    const pair = await Promise.all([post(path, input, headers(f)), post(path, input, headers(f))]);
    const values = await Promise.all(pair.map(accepted));
    expect(values.map((v) => v.replayed).sort()).toEqual([false, true]);
    const after = await state(f);
    for (const k of ['actions', 'receipts', 'jobs'])
      expect((after[k] as unknown[]).length).toBe((before[k] as unknown[]).length + 1);
  });
  it('closes malformed/newer historical receipt failure before now-deleted membership, without echoing stored bytes', async () => {
    const f = await fixture(),
      input = command(f),
      first = await accepted(await post(path, input, headers(f)));
    for (const version of [1, 2]) {
      await db.db
        .updateTable('receipts.personal_commands')
        .set({ outcome: JSON.stringify({ ...first, received: canary }), outcome_version: version })
        .where('command_id', '=', input.commandId)
        .execute();
      const before = await state(f);
      await refused(await post(path, input, headers(f)), 'SERVICE_UNAVAILABLE');
      expect(await state(f)).toEqual(before);
    }
  });
  it('rechecks the actual own-account fence after its wait before reading any accepted receipt', async () => {
    const f = await fixture(),
      input = command(f);
    await accepted(await post(path, input, headers(f)));
    const before = await state(f),
      entered = gate(),
      leave = gate();
    const held = withTransaction(other.db, 'ci.keep-remove-account-wait', async (tx) => {
      await tx
        .updateTable('identity.accounts')
        .set({ status: 'suspended' })
        .where('id', '=', f.person.accountId)
        .execute();
      entered.open();
      await leave.promise;
    });
    await entered.promise;
    const pending = post(path, input, headers(f));
    await expect.poll(waiting).toBeGreaterThan(0);
    leave.open();
    await held;
    await refused(await pending, 'UNIVERSE_UNAVAILABLE');
    expect(await state(f)).toEqual(before);
  });
  it('rechecks epoch after the actual root wait before receipt replay', async () => {
    const f = await fixture(),
      input = command(f);
    await accepted(await post(path, input, headers(f)));
    const entered = gate(),
      leave = gate();
    const held = makeWithPersonalScope(other.db, { lockTimeoutMs: 10000 })(f.person.authority, async (scope) => {
      await transactionOf(scope)
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', f.person.universeId)
        .execute();
      entered.open();
      await leave.promise;
    });
    await entered.promise;
    const pending = post(path, input, headers(f));
    await expect.poll(waiting).toBeGreaterThan(0);
    leave.open();
    await held;
    await refused(await pending, 'PRIVACY_EPOCH_CHANGED');
    const after = await state(f);
    expect(after['actions'] as unknown[]).toHaveLength(1);
    expect(after['receipts'] as unknown[]).toHaveLength(1);
  });
  it.each(['set-first', 'remove-first'] as const)('shares the actual root with place Set (%s)', async (order) => {
    const f = await fixture(),
      entered = gate(),
      leave = gate();
    const held = makeWithPersonalScope(other.db, { lockTimeoutMs: 10000 })(f.person.authority, async (scope) => {
      expect((await accountAccessUseCases({ db: other.db, lockTimeoutMs: 10000 }).fenceOwnAccount(scope)).kind).toBe(
        'active',
      );
      entered.open();
      await leave.promise;
    });
    await entered.promise;
    const set = () =>
      post(
        '/v1/experience/keep/place',
        {
          version: 'keep-place.v1',
          commandId: randomUUID(),
          entry: f.entry,
          expectedPlaceRevision: 0,
          position: { kind: 'reel', positionMs: 12.5 },
        },
        headers(f),
      );
    const first = order === 'set-first' ? set() : post(path, command(f), headers(f));
    await expect.poll(waiting).toBeGreaterThan(0);
    const second = order === 'set-first' ? post(path, command(f), headers(f)) : set();
    await expect.poll(waiting).toBeGreaterThan(1);
    leave.open();
    await held;
    const responses = await Promise.all([first, second]);
    expect(responses[0]?.status).toBe(200);
    expect(responses[1]?.status).toBe(order === 'set-first' ? 200 : 404);
    if (order === 'remove-first') expect(await responses[1].json()).toMatchObject({ code: 'KEEP_ENTRY_UNAVAILABLE' });
    expect((await state(f))['saved']).toEqual([]);
    expect((await state(f))['places']).toEqual([]);
  });
});
