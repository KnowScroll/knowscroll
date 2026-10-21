/** Installed Nest + disposable PG + authored canonical content. No provider, client or privacy-completion claim. */
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  KeepEntrySnapshotSchema,
  KeepPlaceAcceptanceSchema,
  KeepPlaceProblemSchema,
  type KeepPlaceAcceptance,
} from '@knowscroll/contracts';
import {
  createDatabase,
  withTransaction,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import {
  seedKeepFixture,
  seedKeepSessions,
  keepProbeSummary,
  type KeepFixture,
  type KeepVariant,
} from '../support/keep-fixture.js';
import { seedPerson } from '../support/fixtures.js';
import { gate } from '../support/fixture-model.js';
const readPath = '/v1/experience/keep/read',
  setPath = '/v1/experience/keep/place';
describe('Keep place HTTP in installed release (actual adapters, no network providers)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    handle: DatabaseHandle<Database>,
    other: DatabaseHandle<Database>,
    api: ReleaseProcess,
    origin: string;
  const secrets = new Set<string>(),
    canary = 'PRIVATE-KEEP-BODY-CANARY';
  type Auth = KeepFixture & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };
  async function fixture(variant: KeepVariant = 'reel'): Promise<Auth> {
    const f = await seedKeepFixture(handle.db, variant),
      tokens = await seedKeepSessions(handle.db, f.person);
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    return { ...f, tokens };
  }
  const headers = (f: Auth, client: 'native' | 'web' = 'native', epoch = 1): Record<string, string> => ({
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    ...(client === 'native'
      ? { authorization: `Bearer ${f.tokens.native}` }
      : { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.web}`, origin }),
  });
  const post = (path: string, body: unknown, h: Record<string, string>) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  const input = (f: Auth) => ({ version: 'keep-place.v1', target: f.ref });
  const command = (f: Auth, revision = 0, position: unknown = { kind: 'reel', positionMs: 1234.75 }) => ({
    version: 'keep-place.v1',
    commandId: randomUUID(),
    entry: f.entry,
    expectedPlaceRevision: revision,
    position,
  });
  async function problem(response: Response, code: string) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const value = KeepPlaceProblemSchema.parse(await response.json());
    expect(value.code).toBe(code);
    expect(response.status).toBe(value.status);
    expect(JSON.stringify(value)).not.toContain(canary);
    return value;
  }
  async function read(f: Auth, client: 'native' | 'web' = 'native') {
    const r = await post(readPath, input(f), headers(f, client));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    return KeepEntrySnapshotSchema.parse(await r.json());
  }
  async function set(f: Auth, body = command(f), client: 'native' | 'web' = 'native'): Promise<KeepPlaceAcceptance> {
    const r = await post(setPath, body, headers(f, client));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    return KeepPlaceAcceptanceSchema.parse(await r.json());
  }
  async function snapshot(f: Auth) {
    return (
      await sql<{ v: unknown }>`select jsonb_build_object(
      'root',(select to_jsonb(r) from identity.universes r where id=${f.person.universeId}::uuid),
      'saved',(select coalesce(jsonb_agg(to_jsonb(r) order by asset_id),'[]'::jsonb) from experience.saved_items r where universe_id=${f.person.universeId}::uuid),
      'places',(select coalesce(jsonb_agg(to_jsonb(r) order by saved_entry_id),'[]'::jsonb) from experience.saved_places r where universe_id=${f.person.universeId}::uuid),
      'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by command_id),'[]'::jsonb) from receipts.personal_commands r where universe_id=${f.person.universeId}::uuid),
      'evidence',(select count(*) from evidence.observations where universe_id=${f.person.universeId}::uuid),
      'exposures',(select count(*) from experience.exposures where universe_id=${f.person.universeId}::uuid),
      'actions',(select count(*) from experience.actions where universe_id=${f.person.universeId}::uuid),
      'jobs',(select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]'::jsonb) from pgboss.job j)
    ) v`.execute(handle.db)
    ).rows[0]!.v;
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('keep_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-keep-http-fixture', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    other = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-keep-http-barrier', poolMax: 3, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: String(port),
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
      await handle?.close();
      await database?.drop();
    }
  });
  it('reads create no state; fractional Reel clamp/immutable acceptance/replay/CAS are actual HTTP round trips', async () => {
    const f = await fixture(),
      before = await snapshot(f);
    expect(await read(f, 'native')).toMatchObject({
      status: 'available',
      entry: f.entry,
      place: { status: 'none', placeRevision: 0 },
    });
    expect(await read(f, 'web')).toMatchObject({ status: 'available', entry: f.entry });
    expect(await snapshot(f)).toEqual(before);
    const c = command(f, 0, { kind: 'reel', positionMs: 99999.25 }),
      accepted = await set(f, c);
    expect(accepted).toMatchObject({ acceptedPlaceRevision: 1, replayed: false });
    expect(await read(f)).toMatchObject({
      place: { status: 'set', placeRevision: 1, position: { kind: 'reel', positionMs: 25789 } },
    });
    const after = await snapshot(f);
    expect(await set(f, c, 'web')).toEqual({ ...accepted, replayed: true });
    expect(await snapshot(f)).toEqual(after);
    await problem(
      await post(setPath, { ...c, position: { kind: 'reel', positionMs: 3 } }, headers(f)),
      'COMMAND_KEY_REUSED',
    );
    expect(
      await problem(await post(setPath, command(f), headers(f, 'web')), 'KEEP_PLACE_REVISION_STALE'),
    ).toMatchObject({ currentPlaceRevision: 1 });
    expect(await snapshot(f)).toEqual(after);
  });
  it('two actual device commands contend for one CAS winner without overwriting the accepted place', async () => {
    const f = await fixture();
    const candidates = [
      command(f, 0, { kind: 'reel', positionMs: 100.25 }),
      command(f, 0, { kind: 'reel', positionMs: 200.75 }),
    ];
    const replies = await Promise.all(
      candidates.map((c, i) => post(setPath, c, headers(f, i === 0 ? 'native' : 'web'))),
    );
    const winner = replies.findIndex((r) => r.status === 200);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect(KeepPlaceAcceptanceSchema.parse(await replies[winner]!.json())).toMatchObject({ acceptedPlaceRevision: 1 });
    const loser = replies[1 - winner]!;
    expect(await problem(loser, 'KEEP_PLACE_REVISION_STALE')).toMatchObject({ currentPlaceRevision: 1 });
    expect(await read(f)).toMatchObject({ place: { placeRevision: 1, position: candidates[winner]!.position } });
  });
  it('preserves Scroll top-level anchor and fractional logical offset, refuses disclosure/nonexistent anchors without effects', async () => {
    const f = await fixture('ordinary'),
      c = command(f, 0, { kind: 'scroll', blockId: 'violet-eye', offsetWithinBlock: 19.875 });
    expect(await set(f, c)).toMatchObject({ acceptedPlaceRevision: 1 });
    expect(await read(f, 'web')).toMatchObject({ place: { position: c.position } });
    const before = await snapshot(f);
    await problem(
      await post(
        setPath,
        command(f, 1, { kind: 'scroll', blockId: 'violet-eye-cones', offsetWithinBlock: 1.25 }),
        headers(f),
      ),
      'UNPROCESSABLE_REQUEST',
    );
    expect(await snapshot(f)).toEqual(before);
  });
  it('finite native/web guard matrix, strict JSON/body limits and masked errors are no-store before handlers', async () => {
    const f = await fixture(),
      before = await snapshot(f);
    for (const path of [readPath, setPath]) {
      const body = path === readPath ? input(f) : command(f);
      await problem(await post(path, body, {}), 'UNAUTHENTICATED');
      await problem(
        await post(path, body, { ...headers(f), authorization: 'Bearer fixture-invalid' }),
        'UNAUTHENTICATED',
      );
      await problem(
        await post(path, body, { ...headers(f), authorization: `Bearer ${f.tokens.web}` }),
        'UNAUTHENTICATED',
      );
      await problem(
        await post(path, body, {
          ...headers(f, 'web'),
          cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.native}`,
        }),
        'UNAUTHENTICATED',
      );
      await problem(await post(path, body, { authorization: `Bearer ${f.tokens.native}` }), 'SCOPE_MISMATCH');
      await problem(await post(path, body, headers(f, 'native', 2)), 'SCOPE_MISMATCH');
      await problem(await post(path, body, { ...headers(f), origin: 'https://foreign.invalid' }), 'ORIGIN_NOT_ALLOWED');
      const web = headers(f, 'web');
      delete web['origin'];
      await problem(await post(path, body, web), 'ORIGIN_NOT_ALLOWED');
      const malformed = await fetch(origin + path, {
        method: 'POST',
        headers: { ...headers(f), 'content-type': 'application/json' },
        body: '{' + canary,
        signal: AbortSignal.timeout(15000),
      });
      await problem(malformed, 'INVALID_REQUEST');
      await problem(
        await fetch(origin + path, {
          method: 'POST',
          headers: { ...headers(f), 'content-type': 'text/plain' },
          body: canary,
        }),
        'UNSUPPORTED_MEDIA_TYPE',
      );
      await problem(await post(path, { ...body, [canary]: 'x'.repeat(5000) }, headers(f)), 'PAYLOAD_TOO_LARGE');
      const invalid = await problem(await post(path, { ...body, [canary]: canary }, headers(f)), 'INVALID_REQUEST');
      expect(JSON.stringify(invalid)).not.toContain(canary);
    }
    for (const path of ['/V1/EXPERIENCE/KEEP/READ/', '/v1/experience/keep/place/'])
      await problem(await post(path, {}, {}), 'UNAUTHENTICATED');
    const global = await fetch(origin + '/v1/saved', { headers: headers(f) });
    expect(global.status).toBe(200);
    expect(global.headers.get('cache-control')).toBeNull();
    expect(await snapshot(f)).toEqual(before);
  });
  it('withdrawn/corrected Saved state reveals no place; membership ABA and old receipt cannot restore a removed entry', async () => {
    const f = await fixture(),
      c = command(f);
    await set(f, c);
    await handle.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', f.ref.assetId)
      .execute();
    expect(await read(f)).toEqual({
      version: 'keep-place.v1',
      scope: { accountId: f.person.accountId, privacyEpoch: 1 },
      target: f.ref,
      status: 'saved_unavailable',
      entry: f.entry,
    });
    await problem(await post(setPath, c, headers(f)), 'KEEP_ENTRY_UNAVAILABLE');
    const g = await fixture();
    await set(g, command(g));
    await handle.db.updateTable('content.assets').set({ revision: 2 }).where('id', '=', g.ref.assetId).execute();
    expect(await read(g)).toMatchObject({ status: 'saved_unavailable' });
    const live = await fixture(),
      old = command(live);
    await set(live, old);
    for (const kind of ['unsave', 'save']) {
      const r = await post('/v1/actions', { commandId: randomUUID(), kind, target: live.ref }, headers(live));
      expect(r.status).toBe(200);
    }
    const replacement = await read(live);
    expect(replacement.status).toBe('available');
    if (replacement.status !== 'available') throw new Error('CI replacement expected');
    expect(replacement.entry.savedEntryId).not.toBe(live.entry.savedEntryId);
    expect(replacement.place).toEqual({ status: 'none', placeRevision: 0 });
    const before = await snapshot(live);
    await problem(await post(setPath, old, headers(live)), 'KEEP_ENTRY_UNAVAILABLE');
    expect(await snapshot(live)).toEqual(before);
    await problem(
      await post(
        setPath,
        { ...old, commandId: randomUUID(), entry: { ...old.entry, savedEntryId: randomUUID() } },
        headers(live),
      ),
      'KEEP_ENTRY_UNAVAILABLE',
    );
  });
  async function waitBlocked(blockerPid: number) {
    const end = performance.now() + 4000;
    while (performance.now() < end) {
      const rows = await sql<{
        n: number;
      }>`select count(*)::int n from pg_stat_activity where datname=current_database() and ${blockerPid}::int=any(pg_blocking_pids(pid))`.execute(
        handle.db,
      );
      if ((rows.rows[0]?.n ?? 0) > 0) return;
      await pause(5);
    }
    throw new Error('CI real PostgreSQL lock wait not observed');
  }
  it('same-person root wait is measured; an independent person sharing the asset still reads', async () => {
    const f = await fixture('maximal'),
      person = await seedPerson(handle.db),
      tokens = await seedKeepSessions(handle.db, person);
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    const member = await handle.db
      .insertInto('experience.saved_items')
      .values({ universe_id: person.universeId, asset_id: f.ref.assetId, asset_revision: 1, saved_at: new Date() })
      .returning('saved_entry_id')
      .executeTakeFirstOrThrow();
    const g: Auth = { ...f, person, tokens, entry: { ...f.ref, savedEntryId: member.saved_entry_id } },
      entered = gate(),
      release = gate();
    let pid = 0;
    const held = withTransaction(other.db, 'ci.keep-root-barrier', async (trx) => {
      pid = (await sql<{ p: number }>`select pg_backend_pid() p`.execute(trx)).rows[0]!.p;
      await trx
        .selectFrom('identity.universes')
        .select('id')
        .where('id', '=', f.person.universeId)
        .forUpdate()
        .execute();
      entered.open();
      await release.promise;
    });
    await entered.promise;
    const start = performance.now(),
      pending = read(f);
    await waitBlocked(pid);
    expect(await read(g)).toMatchObject({ status: 'available' });
    release.open();
    await held;
    expect(await pending).toMatchObject({ status: 'available' });
    const blockedMs = performance.now() - start;
    expect(blockedMs).toBeLessThan(5000);
    process.stdout.write(
      JSON.stringify({
        event: 'keep-http-lock-probe',
        kind: 'same-person-root',
        blockedEndToEndMs: blockedMs,
        independentPersonSameAssetCompleted: true,
        barrier: 'actual pg_blocking_pids; no synthetic sleep latency',
      }) + '\n',
    );
  });
  it.each(['corrected', 'withdrawn', 'epoch', 'account'] as const)(
    'rechecks %s after the actual gate wait and emits no rejected effects',
    async (mode) => {
      const f = await fixture('maximal'),
        entered = gate(),
        release = gate();
      let pid = 0;
      const held = withTransaction(other.db, 'ci.keep-fresh-after-wait', async (trx) => {
        pid = (await sql<{ p: number }>`select pg_backend_pid() p`.execute(trx)).rows[0]!.p;
        if (mode === 'account')
          await trx
            .selectFrom('identity.accounts')
            .select('id')
            .where('id', '=', f.person.accountId)
            .forUpdate()
            .execute();
        else if (mode === 'epoch')
          await trx
            .selectFrom('identity.universes')
            .select('id')
            .where('id', '=', f.person.universeId)
            .forUpdate()
            .execute();
        else await trx.selectFrom('content.assets').select('id').where('id', '=', f.ref.assetId).forUpdate().execute();
        entered.open();
        await release.promise;
        if (mode === 'account')
          await trx
            .updateTable('identity.accounts')
            .set({ status: 'suspended' })
            .where('id', '=', f.person.accountId)
            .execute();
        else if (mode === 'epoch')
          await trx
            .updateTable('identity.universes')
            .set({ privacy_epoch: 2 })
            .where('id', '=', f.person.universeId)
            .execute();
        else
          await trx
            .updateTable('content.assets')
            .set(mode === 'corrected' ? { revision: 2 } : { status: 'withdrawn' })
            .where('id', '=', f.ref.assetId)
            .execute();
      });
      await entered.promise;
      const start = performance.now(),
        pending = post(
          setPath,
          command(f, 0, { kind: 'scroll', blockId: 'sim-a', offsetWithinBlock: 10.25 }),
          headers(f),
        );
      await waitBlocked(pid);
      release.open();
      await held;
      await problem(
        await pending,
        mode === 'epoch'
          ? 'PRIVACY_EPOCH_CHANGED'
          : mode === 'account'
            ? 'UNIVERSE_UNAVAILABLE'
            : 'KEEP_ENTRY_UNAVAILABLE',
      );
      const ms = performance.now() - start;
      expect(ms).toBeLessThan(5000);
      expect(
        await handle.db
          .selectFrom('experience.saved_places')
          .selectAll()
          .where('universe_id', '=', f.person.universeId)
          .execute(),
      ).toEqual([]);
      expect(
        await handle.db
          .selectFrom('receipts.personal_commands')
          .selectAll()
          .where('universe_id', '=', f.person.universeId)
          .execute(),
      ).toEqual([]);
      process.stdout.write(
        JSON.stringify({
          event: 'keep-http-lock-probe',
          kind: mode,
          blockedEndToEndMs: ms,
          freshRecheck: true,
          barrier: 'actual pg_blocking_pids',
        }) + '\n',
      );
    },
  );
  it.each(['ordinary', 'maximal', 'reel'] as const)(
    'records cold plus20 warm serial HTTP reads and sets for %s',
    async (variant) => {
      const f = await fixture(variant),
        readTimes: number[] = [],
        setTimes: number[] = [];
      const measure = async (work: () => Promise<unknown>) => {
        const t = performance.now();
        await work();
        const elapsed = performance.now() - t;
        expect(elapsed).toBeLessThan(5000);
        return elapsed;
      };
      const coldRead = await measure(() => read(f));
      for (let i = 0; i < 3; i++) await read(f);
      const before = await snapshot(f);
      for (let i = 0; i < 20; i++) readTimes.push(await measure(() => read(f)));
      expect(await snapshot(f)).toEqual(before);
      let revision = 0;
      const position =
        variant === 'reel'
          ? { kind: 'reel', positionMs: 1823.125 }
          : { kind: 'scroll', blockId: variant === 'maximal' ? 'sim-a' : 'violet-eye', offsetWithinBlock: 33.875 };
      const write = async () => {
        const r = await set(f, command(f, revision, position));
        expect(r.acceptedPlaceRevision).toBe(++revision);
      };
      const coldSet = await measure(write);
      for (let i = 0; i < 3; i++) await write();
      for (let i = 0; i < 20; i++) setTimes.push(await measure(write));
      expect(await read(f)).toMatchObject({ place: { status: 'set', placeRevision: 24, position } });
      const after = (await snapshot(f)) as {
        root: { revision: number };
        saved: unknown;
        places: unknown[];
        receipts: unknown[];
        evidence: unknown;
        exposures: unknown;
        actions: unknown;
        jobs: unknown;
      };
      const prior = before as typeof after;
      expect(after.root.revision).toBe(prior.root.revision + 24);
      expect(after.saved).toEqual(prior.saved);
      expect(after.places).toHaveLength(1);
      for (const field of ['evidence', 'exposures', 'actions', 'jobs'] as const)
        expect(after[field]).toEqual(prior[field]);
      expect(
        await handle.db
          .selectFrom('receipts.personal_commands')
          .select('command_id')
          .where('universe_id', '=', f.person.universeId)
          .execute(),
      ).toHaveLength(24);
      for (const table of ['evidence.observations', 'experience.exposures', 'experience.actions'] as const)
        expect(
          await handle.db.selectFrom(table).select('id').where('universe_id', '=', f.person.universeId).execute(),
        ).toEqual([]);
      const pg = (await sql<{ version: string }>`select current_setting('server_version') version`.execute(handle.db))
        .rows[0]!.version;
      process.stdout.write(
        JSON.stringify({
          event: 'keep-http-latency-probe',
          fixture: 'authored canonical; no UX/production percentile claim',
          variant,
          node: process.versions.node,
          pg,
          runner: process.env['RUNNER_OS'] ?? 'unknown',
          documentBytes: f.documentBytes,
          documentSha256: f.documentSha256,
          requestBytes: Buffer.byteLength(JSON.stringify(input(f))),
          warmups: 3,
          samples: 20,
          coldRead,
          coldSet,
          readTimes,
          setTimes,
          readSummary: keepProbeSummary(readTimes),
          setSummary: keepProbeSummary(setTimes),
          timingMeaning:
            'monotonic client-to-installed-HTTP wall time, including full admission/DB/locks; module query/CPU/commit spans reported separately',
        }) + '\n',
      );
    },
  );
});
