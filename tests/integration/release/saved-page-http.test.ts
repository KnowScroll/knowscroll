/** Actions-only installed Nest release + disposable PG; authored metadata, no provider/media claim. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SavedPageResponseSchema,
  SavedListProblemSchema,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  ClearExplorationAcceptanceSchema,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedPerson } from '../support/fixtures.js';
import { seedKeepSessions } from '../support/keep-fixture.js';

const canary = 'PRIVATE-SAVED-QUERY-CURSOR-RECEIVED-CANARY';
describe('real Saved pagination through installed HTTP release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    db: DatabaseHandle<Database>,
    api: ReleaseProcess,
    origin: string;
  const processes: ReleaseProcess[] = [],
    secrets = new Set<string>();
  const selection = { pagination: 'saved-page.v1', filter: 'all', limit: '20' };
  async function fixture(count = 45) {
    const person = await seedPerson(db.db),
      tokens = await seedKeepSessions(db.db, person);
    secrets.add(tokens.web);
    secrets.add(tokens.native);
    const rows = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      kind: i % 2 ? 'scroll' : 'reel',
      title: `[Fixture] Saved HTTP ${i}`,
    }));
    await sql`insert into content.assets(id,kind,revision,status) select id,kind,1,'admitted' from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) x(id uuid,kind text)`.execute(
      db.db,
    );
    await sql`insert into content.asset_revisions(asset_id,revision,provenance_kind,document_version,document,document_sha256,explanation_unit_id,language,title,reading_facts) select id,1,'authored_editorial',kind||'-document.v1','{"fixture":true,"summary":"Authored installed HTTP metadata fixture"}'::jsonb,repeat('b',64),'fixture-saved-http','en',title,'{}'::jsonb from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) x(id uuid,kind text,title text)`.execute(
      db.db,
    );
    await sql`insert into experience.saved_items(universe_id,asset_id,asset_revision,saved_at) select ${person.universeId}::uuid,id,1,'2026-10-22T10:00:00.123456Z'::timestamptz from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) x(id uuid)`.execute(
      db.db,
    );
    return { person, tokens, rows: rows.sort((a, b) => a.id.localeCompare(b.id)) };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const headers = (f: Fixture, web = false, epoch = 1): Record<string, string> => ({
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    ...(web
      ? { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.web}`, origin }
      : { authorization: `Bearer ${f.tokens.native}` }),
  });
  const get = (query: Record<string, string>, h: Record<string, string>, base = origin) =>
    fetch(`${base}/v1/saved?${new URLSearchParams(query)}`, { headers: h, signal: AbortSignal.timeout(15000) });
  async function page(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = SavedPageResponseSchema.parse(await response.json());
    if (result.requestCursor) secrets.add(result.requestCursor);
    if (result.continuation.status === 'more') secrets.add(result.continuation.cursor);
    return result;
  }
  async function refusal(response: Response, code: string) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body = SavedListProblemSchema.parse(await response.json());
    expect(body.code).toBe(code);
    expect(response.status).toBe(body.status);
    expect(JSON.stringify(body)).not.toContain(canary);
    return body;
  }
  async function start(base = origin) {
    const value = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: new URL(base).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    processes.push(value);
    await value.waitForEvent('process.started');
    await waitForHttp(base + '/health');
    return value;
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('saved_page_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-saved-page-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    api = await start();
  });
  afterAll(async () => {
    try {
      for (const process of processes) {
        expect(await process.stop()).toBe(0);
        expect(process.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
        expect(process.rawOutput()).not.toContain(canary);
        for (const secret of secrets) expect(process.rawOutput()).not.toContain(secret);
      }
    } finally {
      await db?.close();
      await database?.drop();
    }
  });
  it.each([false, true])(
    'reads true pages through native/web guards (web=%s), while legacy stays compatible',
    async (web) => {
      const f = await fixture(125),
        seen: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await page(await get({ ...selection, ...(cursor ? { cursor } : {}) }, headers(f, web)));
        expect(result.requestCursor).toBe(cursor);
        expect(result.items.length).toBeLessThanOrEqual(20);
        seen.push(...result.items.map((i) => i.assetId));
        cursor = result.continuation.status === 'more' ? result.continuation.cursor : undefined;
      } while (cursor);
      expect(seen).toEqual(f.rows.map((i) => i.id));
      expect(new Set(seen).size).toBe(125);
      const legacy = await get({ limit: '100' }, headers(f, web));
      expect(legacy.status).toBe(200);
      expect(legacy.headers.get('cache-control')).toBe('private, no-store');
      const value = (await legacy.json()) as { items: unknown[]; pagination?: string };
      expect(value.items).toHaveLength(100);
      expect(value.pagination).toBeUndefined();
      const filtered = await page(await get({ ...selection, filter: 'scroll' }, headers(f, web)));
      expect(filtered.items.every((i) => i.kind === 'scroll')).toBe(true);
    },
  );
  it('guards current session/scope and preserves safe GET Origin policy while masking validation failures', async () => {
    const f = await fixture(1);
    await refusal(await get({ ...selection, cursor: canary }, {}), 'UNAUTHENTICATED');
    await refusal(
      await get({ ...selection, cursor: canary }, { ...headers(f), 'x-ks-scope': `${randomUUID()}:1` }),
      'SCOPE_MISMATCH',
    );
    // D-007 exempts safe GETs from the state-changing Origin guard. The browser still receives
    // no cross-origin read permission; current cookie/session/scope checks remain mandatory.
    const foreignOriginValue = 'https://wrong.fixture.test',
      foreignOrigin = await get(selection, { ...headers(f, true), origin: foreignOriginValue });
    expect(foreignOrigin.headers.get('access-control-allow-origin')).not.toBe(foreignOriginValue);
    const safeRead = await page(foreignOrigin);
    expect(safeRead.scope).toEqual({ accountId: f.person.accountId, privacyEpoch: 1 });
    expect(safeRead.items.map((item) => item.assetId)).toEqual(f.rows.map((row) => row.id));
    for (const query of [
      { ...selection, limit: '51' },
      { ...selection, cursor: canary },
      { ...selection, [canary]: canary },
      { ...selection, pagination: 'saved-page.v2' },
    ])
      await refusal(await get(query, headers(f)), 'INVALID_REQUEST');
  });
  it('uniformly rejects authenticated token tampering, selection/limit and foreign account bindings', async () => {
    const f = await fixture(),
      other = await fixture(1),
      first = await page(await get(selection, headers(f)));
    if (first.continuation.status !== 'more') throw new Error('Expected cursor');
    const cursor = first.continuation.cursor,
      raw = Buffer.from(cursor.slice(5), 'base64url');
    raw[14] = raw[14]! ^ 1;
    for (const query of [
      { ...selection, cursor: `ksp1_${raw.toString('base64url')}` },
      { ...selection, cursor, filter: 'scroll' },
      { ...selection, cursor, limit: '21' },
    ])
      await refusal(await get(query, headers(f)), 'SAVED_CURSOR_UNAVAILABLE');
    await refusal(await get({ ...selection, cursor }, headers(other)), 'SAVED_CURSOR_UNAVAILABLE');
    await page(await get({ ...selection, cursor }, headers(f)));
  });
  it('continues after anchor deletion and rechecks withdrawal/correction without returning a peer or old place', async () => {
    const f = await fixture(),
      first = await page(await get(selection, headers(f)));
    if (first.continuation.status !== 'more') throw new Error('Expected cursor');
    const anchor = first.items[19]!,
      next = f.rows[20]!;
    await db.db
      .deleteFrom('experience.saved_items')
      .where('universe_id', '=', f.person.universeId)
      .where('asset_id', '=', anchor.assetId)
      .execute();
    await db.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', next.id).execute();
    const later = await page(await get({ ...selection, cursor: first.continuation.cursor }, headers(f)));
    expect(later.items.map((i) => i.assetId)).toEqual(f.rows.slice(20, 40).map((i) => i.id));
    expect(later.items[0]).toMatchObject({ assetId: next.id, availability: 'withdrawn', kind: next.kind });
    expect(later.items[0]).not.toHaveProperty('metadata');
    expect(later.items[0]).not.toHaveProperty('position');
    const corrected = f.rows[21]!;
    await sql`insert into content.asset_revisions(asset_id,revision,provenance_kind,document_version,document,document_sha256,explanation_unit_id,language,title,reading_facts) select asset_id,2,provenance_kind,document_version,document,document_sha256,explanation_unit_id,language,title,reading_facts from content.asset_revisions where asset_id=${corrected.id}::uuid and revision=1`.execute(
      db.db,
    );
    await db.db.updateTable('content.assets').set({ revision: 2 }).where('id', '=', corrected.id).execute();
    const current = await page(await get({ ...selection, cursor: first.continuation.cursor }, headers(f)));
    expect(current.items.find((i) => i.assetId === corrected.id)).toMatchObject({
      assetRevision: 1,
      currentAssetRevision: 2,
      availability: 'corrected',
    });
  });
  it('invalidates cursors on an actual other API instance and restart, with a recoverable fresh page', async () => {
    const f = await fixture(),
      first = await page(await get(selection, headers(f)));
    if (first.continuation.status !== 'more') throw new Error('Expected cursor');
    const secondOrigin = `http://127.0.0.1:${await freePort()}`,
      second = await start(secondOrigin);
    try {
      await refusal(
        await get({ ...selection, cursor: first.continuation.cursor }, headers(f), secondOrigin),
        'SAVED_CURSOR_UNAVAILABLE',
      );
      await page(await get(selection, headers(f), secondOrigin));
    } finally {
      expect(await second.stop()).toBe(0);
    }
    expect(await api.stop()).toBe(0);
    api = await start();
    await refusal(
      await get({ ...selection, cursor: first.continuation.cursor }, headers(f)),
      'SAVED_CURSOR_UNAVAILABLE',
    );
    await page(await get(selection, headers(f)));
  });
  it('retains the real Clear barrier and epoch fence before cursor access, preserving Saved rows', async () => {
    const f = await fixture(),
      first = await page(await get(selection, headers(f)));
    if (first.continuation.status !== 'more') throw new Error('Expected cursor');
    const response = await fetch(origin + '/v1/privacy/clear-exploration', {
      method: 'POST',
      headers: { ...headers(f), 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'clear-exploration.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      }),
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(202);
    const accepted = ClearExplorationAcceptanceSchema.parse(await response.json());
    await refusal(await get({ ...selection, cursor: first.continuation.cursor }, headers(f)), 'SCOPE_MISMATCH');
    await refusal(
      await get({ ...selection, cursor: first.continuation.cursor }, headers(f, false, accepted.toEpoch)),
      'UNIVERSE_UNAVAILABLE',
    );
    expect(
      await db.db
        .selectFrom('experience.saved_items')
        .select('asset_id')
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toHaveLength(45);
  });
});
