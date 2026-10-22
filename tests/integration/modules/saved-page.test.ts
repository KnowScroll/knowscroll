/** Actions-only real PostgreSQL, authored metadata fixtures. No renderer/provider/runtime claim. */
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  makeWithPersonalScope,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { readSavedPageMetadata } from '@knowscroll/backend/modules/content/nest-providers';
import { savedPageUseCase } from '@knowscroll/backend/modules/experience/nest-providers';
import type { SavedCursorCodec, SavedPageKey } from '@knowscroll/backend/modules/experience';
import type { SavedPageRequest, SavedPageResponse } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { gate } from '../support/fixture-model.js';

const query: SavedPageRequest = { pagination: 'saved-page.v1', filter: 'all', limit: '20' };
/** Source port fixture only: production AEAD is separately covered through actual installed HTTP. */
function codec(): SavedCursorCodec {
  const tokens = new Map<string, { binding: string; after: SavedPageKey }>();
  return {
    mint(binding, after) {
      const token = `ksp1_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
      tokens.set(token, { binding: JSON.stringify(binding), after });
      return token;
    },
    read(binding, token) {
      const value = tokens.get(token);
      return value?.binding === JSON.stringify(binding) ? value.after : undefined;
    },
  };
}
async function library(db: Kysely<Database>, count = 160) {
  const person = await seedPerson(db);
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    kind: i < 130 ? 'reel' : 'scroll',
    at: `2026-10-22T10:00:00.${i < 110 ? '123456' : i < 130 ? '123455' : '123454'}Z`,
    title: `[Fixture] saved metadata ${i}`,
  }));
  await sql`insert into content.assets(id,kind,revision,status) select id,kind,1,'admitted' from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) x(id uuid,kind text)`.execute(
    db,
  );
  await sql`insert into content.asset_revisions(asset_id,revision,provenance_kind,document_version,document,document_sha256,explanation_unit_id,language,title,reading_facts) select id,1,'authored_editorial',kind||'-document.v1','{"fixture":true,"summary":"Authored metadata fixture only"}'::jsonb,repeat('a',64),'fixture-saved-metadata','en',title,'{}'::jsonb from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) x(id uuid,kind text,title text)`.execute(
    db,
  );
  await sql`insert into experience.saved_items(universe_id,asset_id,asset_revision,saved_at) select ${person.universeId}::uuid,id,1,at::timestamptz from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) x(id uuid,at text)`.execute(
    db,
  );
  return { person, rows: rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)) };
}
describe('complete live Saved keysets over real PG', () => {
  let db: TestDatabase<Database>, other: DatabaseHandle<Database>;
  beforeAll(async () => {
    db = await createTestDatabase<Database>('saved_page');
    other = createDatabase<Database>(
      { ...db.settings, applicationName: 'ci-saved-page-lock' },
      { onIdleClientError: () => undefined },
    );
  });
  afterAll(async () => {
    await other?.close();
    await db?.drop();
  });
  const make = (value = codec()) => {
    const batches: number[] = [];
    return {
      codec: value,
      batches,
      read: savedPageUseCase({
        withScope: makeWithPersonalScope(db.db, { lockTimeoutMs: 10000 }),
        fenceOwn: accountAccessUseCases({ db: db.db, lockTimeoutMs: 10000 }).fenceOwnAccount,
        codec: value,
        metadata: async (scope, refs) => {
          batches.push(refs.length);
          return readSavedPageMetadata(scope, refs);
        },
      }),
    };
  };
  async function page(
    f: ReturnType<typeof make>,
    person: Awaited<ReturnType<typeof seedPerson>>,
    input: SavedPageRequest = query,
  ): Promise<SavedPageResponse> {
    const result = await f.read(person.authority, input);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected real page');
    return result.value;
  }
  it('traverses160 rows beyond100 in stable equal-time/µs order with bounded metadata and no activity writes', async () => {
    const l = await library(db.db),
      f = make();
    const before = await db.db
      .selectFrom('identity.universes')
      .selectAll()
      .where('id', '=', l.person.universeId)
      .executeTakeFirstOrThrow();
    const seen: SavedPageResponse['items'] = [];
    let cursor: string | undefined;
    do {
      const p = await page(f, l.person, { ...query, ...(cursor ? { cursor } : {}) });
      expect(p.requestCursor).toBe(cursor);
      seen.push(...p.items);
      cursor = p.continuation.status === 'more' ? p.continuation.cursor : undefined;
    } while (cursor);
    expect(seen.map((i) => i.assetId)).toEqual(l.rows.map((i) => i.id));
    expect(new Set(seen.map((i) => i.savedEntryId)).size).toBe(160);
    expect(seen[0]?.savedAt).toBe('2026-10-22T10:00:00.123456Z');
    expect(seen[110]?.savedAt).toBe('2026-10-22T10:00:00.123455Z');
    expect(seen[130]?.savedAt).toBe('2026-10-22T10:00:00.123454Z');
    expect(f.batches.length).toBe(8);
    expect(Math.max(...f.batches)).toBe(100);
    expect(
      await db.db
        .selectFrom('identity.universes')
        .selectAll()
        .where('id', '=', l.person.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    for (const table of ['experience.actions', 'experience.exposures', 'receipts.personal_commands'] as const)
      expect(
        await db.db.selectFrom(table).select('universe_id').where('universe_id', '=', l.person.universeId).execute(),
      ).toEqual([]);
  });
  it('filters the entire collection through actual kinds including withdrawn rows after an empty100-window', async () => {
    const l = await library(db.db),
      f = make(),
      target = l.rows.find((i) => i.kind === 'scroll')!;
    await db.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', target.id).execute();
    const first = await page(f, l.person, { ...query, filter: 'scroll' });
    expect(first.items).toEqual([]);
    expect(first.continuation.status).toBe('more');
    if (first.continuation.status !== 'more') throw new Error('Expected continuation');
    const second = await page(f, l.person, { ...query, filter: 'scroll', cursor: first.continuation.cursor });
    expect(second.items).toHaveLength(20);
    expect(second.items.every((i) => i.kind === 'scroll')).toBe(true);
    const withdrawn = second.items.find((i) => i.assetId === target.id);
    expect(withdrawn).toMatchObject({ availability: 'withdrawn', kind: 'scroll' });
    expect(withdrawn).not.toHaveProperty('metadata');
    if (second.continuation.status !== 'more') throw new Error('Expected remaining Scrolls');
    const third = await page(f, l.person, { ...query, filter: 'scroll', cursor: second.continuation.cursor });
    expect(third.items).toHaveLength(10);
    expect(third.continuation.status).toBe('end');
    expect([...second.items, ...third.items].map((i) => i.assetId)).toEqual(
      l.rows.filter((i) => i.kind === 'scroll').map((i) => i.id),
    );
    expect(Math.max(...f.batches)).toBe(100);
  });
  it('continues after deleting its exact anchor; resave replaces UUID above the cursor and is seen on Refresh', async () => {
    const l = await library(db.db, 45),
      f = make(),
      first = await page(f, l.person),
      anchor = first.items[19]!;
    await db.db
      .deleteFrom('experience.saved_items')
      .where('universe_id', '=', l.person.universeId)
      .where('asset_id', '=', anchor.assetId)
      .execute();
    const replacement = await db.db
      .insertInto('experience.saved_items')
      .values({
        universe_id: l.person.universeId,
        asset_id: anchor.assetId,
        asset_revision: 1,
        saved_at: new Date('2026-10-23T00:00:00Z'),
      })
      .returning('saved_entry_id')
      .executeTakeFirstOrThrow();
    expect(replacement.saved_entry_id).not.toBe(anchor.savedEntryId);
    if (first.continuation.status !== 'more') throw new Error('Expected continuation');
    const second = await page(f, l.person, { ...query, cursor: first.continuation.cursor });
    expect(second.items.map((i) => i.assetId)).toEqual(l.rows.slice(20, 40).map((i) => i.id));
    expect(second.items.some((i) => i.assetId === anchor.assetId)).toBe(false);
    expect((await page(f, l.person)).items[0]).toMatchObject({
      assetId: anchor.assetId,
      savedEntryId: replacement.saved_entry_id,
    });
    expect(await f.read(l.person.authority, { ...query, filter: 'scroll', cursor: first.continuation.cursor })).toEqual(
      { kind: 'refused', code: 'SAVED_CURSOR_UNAVAILABLE' },
    );
  });
  it.each(['epoch', 'account'] as const)(
    'rechecks %s authority after an actual lock wait before inspecting a cursor',
    async (mode) => {
      const l = await library(db.db, 1),
        f = make(),
        held = gate(),
        release = gate();
      const lock = other.db.transaction().execute(async (tx) => {
        if (mode === 'epoch')
          await tx
            .selectFrom('identity.universes')
            .select('id')
            .where('id', '=', l.person.universeId)
            .forUpdate()
            .execute();
        else
          await tx
            .selectFrom('identity.accounts')
            .select('id')
            .where('id', '=', l.person.accountId)
            .forUpdate()
            .execute();
        held.open();
        await release.promise;
        if (mode === 'epoch')
          await tx
            .updateTable('identity.universes')
            .set({ privacy_epoch: 2 })
            .where('id', '=', l.person.universeId)
            .execute();
        else
          await tx
            .updateTable('identity.accounts')
            .set({ status: 'suspended' })
            .where('id', '=', l.person.accountId)
            .execute();
      });
      await held.promise;
      const inspect = vi.spyOn(f.codec, 'read'),
        pending = f.read(l.person.authority, { ...query, cursor: `ksp1_${'a'.repeat(70)}` });
      try {
        await expect
          .poll(
            async () =>
              (
                await sql<{
                  n: number;
                }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                  db.db,
                )
              ).rows[0]!.n,
            { timeout: 5000, interval: 20 },
          )
          .toBeGreaterThan(0);
      } finally {
        release.open();
        await lock;
      }
      expect(await pending).toEqual({
        kind: 'refused',
        code: mode === 'epoch' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE',
      });
      expect(inspect).not.toHaveBeenCalled();
    },
  );
});
