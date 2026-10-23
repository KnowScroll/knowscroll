import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '@knowscroll/migrations';
import {
  createDatabase,
  makeWithPersonalScope,
  migrateToLatest,
  transactionOf,
  withTransaction,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { notifyScopeChanged } from '@knowscroll/backend/infrastructure/notices';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { uuidv7 } from '@knowscroll/backend/infrastructure/ids';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  importEditorialScrollUseCase,
  lockKeepPositionTarget,
} from '@knowscroll/backend/modules/content/nest-providers';
import { KEEP_PLACE_OPERATION, type KeepPlaceUseCases } from '@knowscroll/backend/modules/experience';
import { keepPlaceUseCases, keepStore, type KeepPorts } from '@knowscroll/backend/modules/experience/nest-providers';
import type { KeepEntryRef, SetKeepPlace } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { databaseUrl, quoteIdentifier, withAdmin } from '../support/admin.js';
import { experienceUseCases } from '../support/experience.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { starterSource } from '../support/scroll.js';
import { gate } from '../support/fixture-model.js';

/** Synthetic real-PG protocol fixtures only, no served Keep/client/provider/privacy-completion claim. */
describe('durable private Keep places (real PostgreSQL)', () => {
  let database: TestDatabase<Database>, other: DatabaseHandle<Database>;
  let legacy: Awaited<ReturnType<typeof experienceUseCases>>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
  const accounts = (db = database.db) => accountAccessUseCases({ db, lockTimeoutMs: 10_000 });
  const cases = (overrides: Partial<KeepPorts> = {}): KeepPlaceUseCases =>
    keepPlaceUseCases({
      withScope: withScope(),
      fenceOwn: accounts().fenceOwnAccount,
      target: lockKeepPositionTarget,
      ...overrides,
    });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('keep_place');
    other = createDatabase<Database>(
      { ...database.settings, applicationName: 'ci-keep-other' },
      { onIdleClientError: () => undefined },
    );
    legacy = await experienceUseCases(database);
  });
  afterAll(async () => {
    await legacy.close();
    await other.close();
    await database.drop();
  });
  async function reel() {
    const assetId = randomUUID(),
      digest = createHash('sha256').update(assetId).digest('hex'),
      mediaId = randomUUID();
    const key = `sha256/${digest.slice(0, 2)}/${digest}.mp4`;
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId,
      revision: 1,
      title: '[Fixture] Keep protocol',
      summary: 'Synthetic stored document only',
      language: 'en',
      truthLabel: 'generated',
      fixture: true,
      captions: 'burned_in',
      mediaKey: key,
      durationMs: 25789,
      width: 720,
      height: 1280,
    };
    await database.db
      .insertInto('content.assets')
      .values({ id: assetId, kind: 'reel', revision: 1, status: 'admitted' })
      .execute();
    await database.db
      .insertInto('content.asset_revisions')
      .values({
        asset_id: assetId,
        revision: 1,
        provenance_kind: 'cutroom_import',
        document_version: 'reel-document.v1',
        document: JSON.stringify(document),
        document_sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
        title: document.title,
        explanation_unit_id: 'ci-keep',
        language: 'en',
        reading_facts: '{}',
      })
      .execute();
    await database.db
      .insertInto('content.media_objects')
      .values({
        id: mediaId,
        logical_key: key,
        backend: 'local',
        sha256: digest,
        mime: 'video/mp4',
        size_bytes: 1,
        probe: '{}',
      })
      .execute();
    await database.db
      .insertInto('content.reel_imports')
      .values({
        run_id: randomUUID(),
        asset_id: assetId,
        asset_revision: 1,
        media_id: mediaId,
        script_name: 'greenhouse',
        fixture: true,
      })
      .execute();
    return { assetId, assetRevision: 1 };
  }
  async function fixture(kind: 'reel' | 'scroll' = 'reel') {
    const person = await seedPerson(database.db);
    let ref: { assetId: string; assetRevision: number };
    if (kind === 'reel') ref = await reel();
    else {
      const source = starterSource(),
        assetId = randomUUID();
      source['assetId'] = assetId;
      source['reference'] = 'ci-keep-place-fixture';
      expect(await importEditorialScrollUseCase(database.db)(source)).toMatchObject({ kind: 'imported' });
      ref = { assetId, assetRevision: 1 };
    }
    expect(
      await legacy.applyAction(person.authority, { commandId: randomUUID(), kind: 'save', target: ref }),
    ).toMatchObject({ kind: 'applied' });
    const row = await database.db
      .selectFrom('experience.saved_items')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .where('asset_id', '=', ref.assetId)
      .executeTakeFirstOrThrow();
    const entry = { ...ref, savedEntryId: row.saved_entry_id };
    return { person, ref, entry, row };
  }
  const command = (entry: KeepEntryRef, expectedPlaceRevision = 0): SetKeepPlace => ({
    version: 'keep-place.v1',
    commandId: randomUUID(),
    entry,
    expectedPlaceRevision,
    position: { kind: 'reel', positionMs: 1234.75 },
  });
  const read = (f: Awaited<ReturnType<typeof fixture>>) =>
    cases().readEntry(f.person.authority, { version: 'keep-place.v1', target: f.ref });
  async function state(person: FixturePerson) {
    const result = await sql<{ snapshot: unknown }>`select jsonb_build_object(
      'revision',(select revision from identity.universes where id=${person.universeId}::uuid),
      'places',(select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from experience.saved_places p where universe_id=${person.universeId}::uuid),
      'receipts',(select count(*) from receipts.personal_commands where universe_id=${person.universeId}::uuid),
      'actions',(select count(*) from experience.actions where universe_id=${person.universeId}::uuid),
      'exposures',(select count(*) from experience.exposures where universe_id=${person.universeId}::uuid),
      'jobs',(select count(*) from pgboss.job where data->>'universeId'=${person.universeId})
    ) as snapshot`.execute(database.db);
    return result.rows[0]!.snapshot;
  }
  async function waiting() {
    return (
      await sql<{ n: number }>`select count(*)::int n from pg_stat_activity where datname=current_database()
      and wait_event_type='Lock'`.execute(database.db)
    ).rows[0]!.n;
  }
  async function replace(person: FixturePerson, entry: KeepEntryRef, hold?: { open(): void; promise: Promise<void> }) {
    return makeWithPersonalScope(other.db, { lockTimeoutMs: 10_000 })(person.authority, async (sc) => {
      expect((await accounts(other.db).fenceOwnAccount(sc)).kind).toBe('active');
      const tx = transactionOf(sc);
      await tx
        .deleteFrom('experience.saved_items')
        .where('universe_id', '=', person.universeId)
        .where('asset_id', '=', entry.assetId)
        .execute();
      await tx
        .insertInto('experience.saved_items')
        .values({
          universe_id: person.universeId,
          asset_id: entry.assetId,
          asset_revision: entry.assetRevision,
          saved_at: new Date(),
          saved_entry_id: uuidv7(),
        })
        .execute();
      if (hold) {
        hold.open();
        await hold.promise;
      }
    });
  }

  it('migrates actual existing Saved rows from the full ordered28 prefix to independent IDs with no fabricated places', async () => {
    const name = `ks_it_keep_prefix28_${randomUUID().replaceAll('-', '')}`;
    await withAdmin((client) => client.query(`create database ${quoteIdentifier(name)} template template0`));
    const handle = createDatabase(
      { ...database.settings, url: databaseUrl(name) },
      { onIdleClientError: () => undefined },
    );
    try {
      const migrations = loadMigrations();
      const index = migrations.findIndex((m) => m.name === '0029_keep_places');
      expect(index).toBe(28);
      const all = migrations.slice(0, index + 1);
      expect(all.at(-1)?.name).toBe('0029_keep_places');
      expect((await migrateToLatest(handle.db, all.slice(0, -1))).kind).toBe('migrated');
      const typed = handle.db as unknown as Kysely<Database>;
      const person = await seedPerson(typed),
        asset = randomUUID();
      await typed
        .insertInto('content.assets')
        .values({ id: asset, kind: 'reel', revision: 1, status: 'admitted' })
        .execute();
      // Raw legacy shape deliberately lacks the new column before applying migration29.
      await sql`insert into experience.saved_items(universe_id,asset_id,asset_revision,saved_at)
        values(${person.universeId}::uuid,${asset}::uuid,1,'2026-01-01T00:00:00Z')`.execute(handle.db);
      expect((await migrateToLatest(handle.db, all)).kind).toBe('migrated');
      const rows = await typed.selectFrom('experience.saved_items').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ universe_id: person.universeId, asset_id: asset, asset_revision: 1 });
      expect(rows[0]!.saved_entry_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(rows[0]!.saved_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(await typed.selectFrom('experience.saved_places').selectAll().execute()).toEqual([]);
    } finally {
      await handle.close();
      await withAdmin((client) => client.query(`drop database ${quoteIdentifier(name)} with (force)`));
    }
  });

  it('keeps Saved ID/ref/time on Save-noop and exposes actual stored ref despite the legacy requested-revision echo', async () => {
    const f = await fixture();
    expect(f.entry.savedEntryId.split('-')[2]?.[0]).toBe('7');
    expect(await read(f)).toMatchObject({
      kind: 'ok',
      value: { status: 'available', entry: f.entry, place: { status: 'none', placeRevision: 0 } },
    });
    await database.db.updateTable('content.assets').set({ revision: 2 }).where('id', '=', f.ref.assetId).execute();
    expect(
      await legacy.applyAction(f.person.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target: { ...f.ref, assetRevision: 2 },
      }),
    ).toMatchObject({ kind: 'applied', outcome: { changed: false, assetRevision: 2 } });
    expect(
      await database.db
        .selectFrom('experience.saved_items')
        .selectAll()
        .where('universe_id', '=', f.person.universeId)
        .executeTakeFirst(),
    ).toEqual(f.row);
    expect(await read(f)).toEqual({
      kind: 'ok',
      value: {
        version: 'keep-place.v1',
        scope: { accountId: f.person.accountId, privacyEpoch: 1 },
        target: f.ref,
        status: 'saved_unavailable',
        entry: f.entry,
      },
    });
    expect(
      await cases().readEntry(f.person.authority, { version: 'keep-place.v1', target: { ...f.ref, assetRevision: 2 } }),
    ).toMatchObject({ kind: 'ok', value: { status: 'not_saved' } });
  });

  it('preserves fractional units, clamps actual Reel duration, accepts immutable replay before old CAS and hashes the original command', async () => {
    const f = await fixture(),
      c = command(f.entry);
    c.position = { kind: 'reel', positionMs: 99999.5 };
    const before = await state(f.person);
    const first = await cases().setPlace(f.person.authority, c);
    expect(first).toMatchObject({
      kind: 'ok',
      value: { entry: c.entry, basePlaceRevision: 0, acceptedPlaceRevision: 1, replayed: false },
    });
    const replay = await cases().setPlace(f.person.authority, c);
    expect(first.kind === 'ok' && replay).toEqual({
      kind: 'ok',
      value: { ...(first.kind === 'ok' ? first.value : {}), replayed: true },
    });
    expect(await read(f)).toMatchObject({
      kind: 'ok',
      value: { place: { status: 'set', placeRevision: 1, position: { kind: 'reel', positionMs: 25789 } } },
    });
    expect(await cases().setPlace(f.person.authority, { ...c, position: { kind: 'reel', positionMs: 25789 } })).toEqual(
      { kind: 'refused', code: 'COMMAND_KEY_REUSED' },
    );
    const equalNew = { ...c, commandId: randomUUID(), expectedPlaceRevision: 1 };
    expect(await cases().setPlace(f.person.authority, equalNew)).toMatchObject({
      kind: 'ok',
      value: { acceptedPlaceRevision: 2 },
    });
    expect(
      await cases().setPlace(f.person.authority, {
        ...command(f.entry, 2),
        position: { kind: 'reel', positionMs: 12.75 },
      }),
    ).toMatchObject({ kind: 'ok', value: { acceptedPlaceRevision: 3 } });
    expect(await read(f)).toMatchObject({
      kind: 'ok',
      value: { place: { position: { kind: 'reel', positionMs: 12.75 } } },
    });
    const after = await state(f.person);
    expect(after).toMatchObject({
      ...(before as object),
      revision: f.person.authority.privacyEpoch + 3,
      receipts: 4,
      places: expect.any(Array) as unknown,
    });
    const receipt = await database.db
      .selectFrom('receipts.personal_commands')
      .select('outcome')
      .where('command_id', '=', c.commandId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(receipt.outcome)).not.toContain('position');
  });

  it('stores logical Scroll offsets only at actual top-level anchors, never disclosure children or wrong kind', async () => {
    const f = await fixture('scroll');
    for (const position of [
      { kind: 'scroll', blockId: 'violet-eye-cones', offsetWithinBlock: 1 },
      { kind: 'reel', positionMs: 1 },
    ])
      expect(await cases().setPlace(f.person.authority, { ...command(f.entry), position })).toEqual({
        kind: 'refused',
        code: 'UNPROCESSABLE_REQUEST',
      });
    expect(
      await cases().setPlace(f.person.authority, {
        ...command(f.entry),
        position: { kind: 'scroll', blockId: 'violet-eye', offsetWithinBlock: 123456.75 },
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(await read(f)).toMatchObject({
      kind: 'ok',
      value: { place: { position: { kind: 'scroll', blockId: 'violet-eye', offsetWithinBlock: 123456.75 } } },
    });
  });

  it('allows one concurrent CAS winner and returns only current revision to the authorised loser', async () => {
    const f = await fixture(),
      a = command(f.entry),
      b = command(f.entry);
    const results = await Promise.all([
      cases().setPlace(f.person.authority, a),
      cases().setPlace(f.person.authority, b),
    ]);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.find((r) => r.kind === 'refused')).toEqual({
      kind: 'refused',
      code: 'KEEP_PLACE_REVISION_STALE',
      currentPlaceRevision: 1,
    });
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .select('command_id')
        .where('operation', '=', KEEP_PLACE_OPERATION)
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toHaveLength(1);
  });

  it('Unsave cascades the place, resave replaces ID, old writes/replays fail before receipt; legacy Unsave ABA remains explicit', async () => {
    const f = await fixture(),
      c = command(f.entry);
    expect(await cases().setPlace(f.person.authority, c)).toMatchObject({ kind: 'ok' });
    await legacy.applyAction(f.person.authority, { commandId: randomUUID(), kind: 'unsave', target: f.ref });
    expect(
      await database.db
        .selectFrom('experience.saved_places')
        .selectAll()
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toEqual([]);
    await legacy.applyAction(f.person.authority, { commandId: randomUUID(), kind: 'save', target: f.ref });
    const member = await keepStoreMembership(f);
    expect(member.savedEntryId).not.toBe(f.entry.savedEntryId);
    for (const old of [c, { ...c, commandId: randomUUID() }])
      expect(await cases().setPlace(f.person.authority, old)).toEqual({
        kind: 'refused',
        code: 'KEEP_ENTRY_UNAVAILABLE',
      });
    expect(await cases().setPlace(f.person.authority, command(member))).toMatchObject({ kind: 'ok' });
    // Delayed asset-keyed legacy Unsave still has no membership CAS. Do not claim it was repaired.
    await legacy.applyAction(f.person.authority, { commandId: randomUUID(), kind: 'unsave', target: f.ref });
    expect(await read(f)).toMatchObject({ kind: 'ok', value: { status: 'not_saved' } });
  });
  async function keepStoreMembership(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await withScope()(f.person.authority, async (sc) => keepStore.membership(sc, f.ref.assetId));
    if (result.kind !== 'entered' || !result.value) throw new Error('CI membership absent');
    return result.value;
  }

  it('guards safe counters/root exhaustion and refuses corrupt or mismatched stored acceptance/outcome versions', async () => {
    const f = await fixture(),
      c = command(f.entry);
    const first = await cases().setPlace(f.person.authority, c);
    if (first.kind !== 'ok') throw new Error('CI acceptance missing');
    for (const outcome of [
      { ...first.value, entry: { ...first.value.entry, savedEntryId: randomUUID() } },
      { ...first.value, basePlaceRevision: 8, acceptedPlaceRevision: 9 },
      { ...first.value, position: c.position },
      { ...first.value, scope: { ...first.value.scope, privacyEpoch: 8 } },
    ]) {
      await database.db
        .updateTable('receipts.personal_commands')
        .set({ outcome: JSON.stringify(outcome) })
        .where('command_id', '=', c.commandId)
        .execute();
      expect(await cases().setPlace(f.person.authority, c)).toEqual({ kind: 'refused', code: 'SERVICE_UNAVAILABLE' });
    }
    await database.db
      .updateTable('receipts.personal_commands')
      .set({ outcome: JSON.stringify(first.value), outcome_version: 2 })
      .where('command_id', '=', c.commandId)
      .execute();
    expect(await cases().setPlace(f.person.authority, c)).toEqual({ kind: 'refused', code: 'SERVICE_UNAVAILABLE' });
    await database.db
      .updateTable('receipts.personal_commands')
      .set({ outcome_version: 0 })
      .where('command_id', '=', c.commandId)
      .execute();
    expect(await cases().setPlace(f.person.authority, c)).toEqual({ kind: 'refused', code: 'COMMAND_KEY_REUSED' });
    await database.db
      .updateTable('receipts.personal_commands')
      .set({ outcome_version: 1 })
      .where('command_id', '=', c.commandId)
      .execute();
    await database.db
      .updateTable('identity.universes')
      .set({ revision: 2147483647 })
      .where('id', '=', f.person.universeId)
      .execute();
    expect(await cases().setPlace(f.person.authority, c)).toMatchObject({ kind: 'ok', value: { replayed: true } });
    expect(await cases().setPlace(f.person.authority, command(f.entry, 1))).toEqual({
      kind: 'refused',
      code: 'SERVICE_UNAVAILABLE',
    });
    const max = await fixture();
    await database.db
      .insertInto('experience.saved_places')
      .values({
        universe_id: max.person.universeId,
        saved_entry_id: max.entry.savedEntryId,
        place_revision: String(Number.MAX_SAFE_INTEGER),
        position: JSON.stringify({ kind: 'reel', positionMs: 1 }),
      })
      .execute();
    expect(await cases().setPlace(max.person.authority, command(max.entry, Number.MAX_SAFE_INTEGER))).toEqual({
      kind: 'refused',
      code: 'KEEP_PLACE_COUNTER_EXHAUSTED',
    });
  });

  it('strict JSON/cross-reference/foreign membership refusals have no effects, and SQL rejects malformed branches without numeric-cast errors', async () => {
    const f = await fixture(),
      foreign = await fixture(),
      baseline = await state(f.person);
    for (const input of [
      { ...command(f.entry), secret: 'private-canary' },
      { ...command(f.entry), position: { kind: 'reel', positionMs: -1 } },
    ])
      expect(await cases().setPlace(f.person.authority, input)).toEqual({ kind: 'refused', code: 'INVALID_REQUEST' });
    expect(await cases().setPlace(f.person.authority, command(foreign.entry))).toEqual({
      kind: 'refused',
      code: 'KEEP_ENTRY_UNAVAILABLE',
    });
    expect(await cases().setPlace(f.person.authority, command({ ...f.entry, assetRevision: 2 }))).toEqual({
      kind: 'refused',
      code: 'KEEP_ENTRY_UNAVAILABLE',
    });
    expect(await state(f.person)).toEqual(baseline);
    for (const position of [
      { kind: 'reel', positionMs: 'bad' },
      { kind: 'reel', positionMs: 1, secret: 'canary' },
      { kind: 'scroll', blockId: 'parent', offsetWithinBlock: 'bad' },
      { kind: 'scroll', blockId: 'x', offsetWithinBlock: 1 },
      { kind: 'reel', positionMs: 1e100 },
      {},
      [],
    ]) {
      await expect(
        sql`insert into experience.saved_places(universe_id,saved_entry_id,place_revision,position)
        values(${f.person.universeId}::uuid,${f.entry.savedEntryId}::uuid,1,${JSON.stringify(position)}::jsonb)`.execute(
          database.db,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      database.db
        .updateTable('experience.saved_items')
        .set({ asset_revision: 2 })
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['receipt', 'place', 'hint'] as const)('rolls back all effects after injected %s failure', async (stage) => {
    const f = await fixture(),
      c = command(f.entry),
      before = await state(f.person);
    const failing: Partial<KeepPorts> =
      stage === 'hint'
        ? {
            notify: async (sc, change) => {
              await notifyScopeChanged(sc, change);
              throw new Error('CI rollback hint');
            },
          }
        : stage === 'receipt'
          ? {
              store: {
                ...keepStore,
                beginReceipt: async (sc, key) => {
                  await keepStore.beginReceipt(sc, key);
                  throw new Error('CI rollback receipt');
                },
              },
            }
          : {
              store: {
                ...keepStore,
                write: async (sc, id, base, position) => {
                  await keepStore.write(sc, id, base, position);
                  throw new Error('CI rollback place');
                },
              },
            };
    await expect(cases(failing).setPlace(f.person.authority, c)).rejects.toThrow('CI rollback');
    expect(await state(f.person)).toEqual(before);
    expect(await cases().setPlace(f.person.authority, c)).toMatchObject({
      kind: 'ok',
      value: { acceptedPlaceRevision: 1 },
    });
  });

  it.each(['withdrawn', 'corrected'] as const)(
    'refuses without a receipt after waiting behind Content %s',
    async (mode) => {
      const f = await fixture(),
        changed = gate(),
        release = gate(),
        before = await state(f.person);
      const mutation = withTransaction(other.db, 'ci.keep-content-first', async (tx) => {
        await tx
          .updateTable('content.assets')
          .set(mode === 'withdrawn' ? { status: 'withdrawn' } : { revision: 2 })
          .where('id', '=', f.ref.assetId)
          .execute();
        changed.open();
        await release.promise;
      });
      await changed.promise;
      const pending = cases().setPlace(f.person.authority, command(f.entry));
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
      } finally {
        release.open();
      }
      await mutation;
      expect(await pending).toEqual({ kind: 'refused', code: 'KEEP_ENTRY_UNAVAILABLE' });
      expect(await state(f.person)).toEqual(before);
    },
  );

  it.each(['withdrawn', 'corrected'] as const)(
    'commits before a waiting Content %s then refuses immutable replay',
    async (mode) => {
      const f = await fixture(),
        held = gate(),
        release = gate(),
        c = command(f.entry);
      const pending = cases({
        target: async (...args) => {
          const value = await lockKeepPositionTarget(...args);
          held.open();
          await release.promise;
          return value;
        },
      }).setPlace(f.person.authority, c);
      await held.promise;
      const mutation = withTransaction(other.db, 'ci.keep-content-second', async (tx) => {
        await tx
          .updateTable('content.assets')
          .set(mode === 'withdrawn' ? { status: 'withdrawn' } : { revision: 2 })
          .where('id', '=', f.ref.assetId)
          .execute();
      });
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
      } finally {
        release.open();
      }
      expect(await pending).toMatchObject({ kind: 'ok' });
      await mutation;
      expect(await cases().setPlace(f.person.authority, c)).toEqual({
        kind: 'refused',
        code: 'KEEP_ENTRY_UNAVAILABLE',
      });
    },
  );

  it.each([false, true])(
    'rechecks replaced membership after a root wait before new/replayed Set (%s)',
    async (replay) => {
      const f = await fixture(),
        c = command(f.entry);
      if (replay) expect(await cases().setPlace(f.person.authority, c)).toMatchObject({ kind: 'ok' });
      const held = gate(),
        release = gate();
      const replacing = replace(f.person, f.entry, { open: () => held.open(), promise: release.promise });
      await held.promise;
      const pending = cases().setPlace(f.person.authority, c);
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
      } finally {
        release.open();
      }
      await replacing;
      expect(await pending).toEqual({ kind: 'refused', code: 'KEEP_ENTRY_UNAVAILABLE' });
    },
  );

  it.each([false, true])(
    'orders new/replayed Set before replacement, then never restores its old place (%s)',
    async (replay) => {
      const f = await fixture(),
        c = command(f.entry);
      if (replay) await cases().setPlace(f.person.authority, c);
      const held = gate(),
        release = gate();
      const pending = cases({
        target: async (...args) => {
          const value = await lockKeepPositionTarget(...args);
          held.open();
          await release.promise;
          return value;
        },
      }).setPlace(f.person.authority, c);
      await held.promise;
      const replacing = replace(f.person, f.entry);
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
      } finally {
        release.open();
      }
      expect(await pending).toMatchObject({ kind: 'ok' });
      await replacing;
      expect(await cases().setPlace(f.person.authority, c)).toEqual({
        kind: 'refused',
        code: 'KEEP_ENTRY_UNAVAILABLE',
      });
      expect(await read(f)).toMatchObject({ kind: 'ok', value: { place: { status: 'none', placeRevision: 0 } } });
    },
  );

  it.each(['advance_epoch', 'suspend'] as const)(
    'orders Keep before actual Identity %s, then fences old scope/receipt',
    async (mode) => {
      const f = await fixture(),
        c = command(f.entry),
        held = gate(),
        release = gate();
      const pending = cases({
        target: async (...args) => {
          const value = await lockKeepPositionTarget(...args);
          held.open();
          await release.promise;
          return value;
        },
      }).setPlace(f.person.authority, c);
      await held.promise;
      const invalidation = accounts(other.db).invalidateOwnAccountAccess(f.person.authority, mode);
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
      } finally {
        release.open();
      }
      expect(await pending).toMatchObject({ kind: 'ok' });
      expect(await invalidation).toMatchObject({ kind: 'entered', value: { kind: 'invalidated' } });
      expect(await cases().setPlace(f.person.authority, c)).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
      const fresh = { ...f.person.authority, privacyEpoch: 2 };
      expect(await cases().setPlace(fresh, c)).toEqual({
        kind: 'refused',
        code: mode === 'suspend' ? 'UNIVERSE_UNAVAILABLE' : 'COMMAND_KEY_REUSED',
      });
      if (mode === 'advance_epoch')
        expect(await cases().readEntry(fresh, { version: 'keep-place.v1', target: f.ref })).toMatchObject({
          kind: 'ok',
          value: { scope: { privacyEpoch: 2 }, place: { placeRevision: 1 } },
        });
    },
  );

  it.each(['advance_epoch', 'suspend'] as const)(
    'waits behind committed actual Identity %s before current authority',
    async (mode) => {
      const f = await fixture(),
        c = command(f.entry),
        blocker = await other.pool.connect();
      await blocker.query('select pg_advisory_lock(246029)');
      await sql`create function identity.ci_keep_commit() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(246029); return new; end $$`.execute(database.db);
      await sql`create constraint trigger ci_keep_commit after update on identity.universes deferrable initially deferred
      for each row when (new.privacy_epoch > old.privacy_epoch) execute function identity.ci_keep_commit()`.execute(
        database.db,
      );
      const invalidation = accounts(other.db).invalidateOwnAccountAccess(f.person.authority, mode);
      let pending: ReturnType<KeepPlaceUseCases['setPlace']> | undefined;
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
        pending = cases().setPlace(f.person.authority, c);
        await expect.poll(waiting).toBeGreaterThan(1);
      } finally {
        await blocker.query('select pg_advisory_unlock(246029)');
        blocker.release();
      }
      try {
        await invalidation;
        expect(await pending).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
        expect(
          await database.db
            .selectFrom('experience.saved_places')
            .selectAll()
            .where('universe_id', '=', f.person.universeId)
            .execute(),
        ).toEqual([]);
      } finally {
        await sql`drop trigger ci_keep_commit on identity.universes`.execute(database.db);
        await sql`drop function identity.ci_keep_commit()`.execute(database.db);
      }
    },
  );
  it('full erasure removes latest place and receipts from all epochs; stale scope/work and erased membership cannot restore them', async () => {
    const f = await fixture(),
      old = command(f.entry);
    expect(await cases().setPlace(f.person.authority, old)).toMatchObject({ kind: 'ok' });
    expect(await accounts().invalidateOwnAccountAccess(f.person.authority, 'advance_epoch')).toMatchObject({
      kind: 'entered',
    });
    const fresh = { ...f.person.authority, privacyEpoch: 2 };
    expect(await cases().setPlace(fresh, command(f.entry, 1))).toMatchObject({ kind: 'ok' });
    const epochs = await database.db
      .selectFrom('receipts.personal_commands')
      .select('privacy_epoch')
      .where('universe_id', '=', f.person.universeId)
      .execute();
    expect(new Set(epochs.map((r) => r.privacy_epoch))).toEqual(new Set([1, 2]));
    const result = await withScope()(fresh, async (sc) => {
      expect((await accounts().fenceOwnAccount(sc)).kind).toBe('active');
      return eraseUniverse(sc, personalStores);
    });
    expect(result.kind === 'entered' && result.value.every((r) => r.status === 'completed')).toBe(true);
    expect(
      await database.db
        .selectFrom('experience.saved_places')
        .selectAll()
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', f.person.universeId)
        .execute(),
    ).toEqual([]);
    expect(await cases().setPlace(fresh, old)).toEqual({ kind: 'refused', code: 'KEEP_ENTRY_UNAVAILABLE' });
    expect(await cases().setPlace(f.person.authority, old)).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
    expect(
      await withScope()({ ...f.person.authority, actor: { kind: 'system', purpose: 'ci-stale-work' } }, () =>
        Promise.resolve('must not run'),
      ),
    ).toMatchObject({ kind: 'refused', refusal: { kind: 'epoch_changed' } });
    expect(await cases().readEntry(fresh, { version: 'keep-place.v1', target: f.ref })).toMatchObject({
      kind: 'ok',
      value: { status: 'not_saved' },
    });
  });
});
