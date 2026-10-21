import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitDocument } from '@knowscroll/scroll-model/admission';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  withTransaction,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import type { AccountAccess, PersonalScopeTx } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { LOCK_KEEP_POSITION_TARGET, type LockKeepPositionTarget } from '@knowscroll/backend/modules/content';
import {
  contentProviders,
  importEditorialScrollUseCase,
  lockKeepPositionTarget,
} from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { starterSource } from '../support/scroll.js';
import { gate } from '../support/fixture-model.js';

/** Synthetic PostgreSQL fixtures only. No media bytes, provider, Keep storage or HTTP journey. */
describe('Content Keep position target (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let other: DatabaseHandle<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('keep_position_target');
    other = createDatabase<Database>(database.settings, { onIdleClientError: () => undefined });
  });
  afterAll(async () => {
    await other.close();
    await database.drop();
  });
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
  const access = () => accountAccessUseCases({ db: database.db, lockTimeoutMs: 10_000 });
  async function fenced(sc: PersonalScopeTx): Promise<AccountAccess> {
    const result = await access().fenceOwnAccount(sc);
    if (result.kind !== 'active') throw new Error('CI fixture account fence failed');
    return result.owner;
  }
  async function read(person: FixturePerson, ref: unknown, port: LockKeepPositionTarget = lockKeepPositionTarget) {
    const result = await scope()(person.authority, async (sc) => port(sc, await fenced(sc), ref));
    if (result.kind !== 'entered') throw new Error('CI fixture scope refused');
    return result.value;
  }
  async function scroll() {
    const source = starterSource();
    const assetId = randomUUID();
    source['assetId'] = assetId;
    source['reference'] = 'ci-keep-target-only-no-live-provenance';
    expect(await importEditorialScrollUseCase(database.db)(source)).toMatchObject({ kind: 'imported' });
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select('document')
      .where('asset_id', '=', assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    const parsed = admitDocument(row.document);
    if (parsed.kind !== 'valid') throw new Error('CI Scroll document invalid');
    return { ref: { assetId, assetRevision: 1 }, document: parsed.document };
  }
  async function reel(durationMs = 25789) {
    const assetId = randomUUID(),
      mediaId = randomUUID(),
      digest = createHash('sha256').update(assetId).digest('hex');
    const mediaKey = `sha256/${digest.slice(0, 2)}/${digest}.mp4`;
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId,
      revision: 1,
      title: '[Fixture] private metadata canary',
      summary: 'CI only, not real media bytes',
      language: 'en',
      truthLabel: 'generated',
      fixture: true,
      captions: 'burned_in',
      mediaKey,
      durationMs,
      width: 720,
      height: 1280,
    };
    await database.db
      .insertInto('content.assets')
      .values({ id: assetId, revision: 1, kind: 'reel', status: 'admitted' })
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
        explanation_unit_id: 'ci-keep-target',
        language: 'en',
        title: document.title,
        reading_facts: JSON.stringify({ reelDurationMs: 59000, privateCanary: 'not returned' }),
      })
      .execute();
    await database.db
      .insertInto('content.media_objects')
      .values({
        id: mediaId,
        logical_key: mediaKey,
        backend: 'local',
        sha256: digest,
        size_bytes: 1,
        mime: 'video/mp4',
        probe: JSON.stringify({ durationMs }),
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
    return { ref: { assetId, assetRevision: 1 }, document, mediaId };
  }
  async function change(assetId: string, mode: 'withdrawn' | 'corrected') {
    return withTransaction(other.db, 'ci.keep-target-change', async (trx) => {
      await trx
        .updateTable('content.assets')
        .set(mode === 'withdrawn' ? { status: 'withdrawn' } : { revision: 2 })
        .where('id', '=', assetId)
        .execute();
    });
  }
  async function waiting() {
    const result = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'`.execute(database.db);
    return result.rows[0]?.n ?? 0;
  }

  it('binds the actual production provider and returns only canonical top-level anchors, never disclosure children', async () => {
    const person = await seedPerson(database.db),
      fixture = await scroll();
    const provider = contentProviders().find((p) => p.provide === LOCK_KEEP_POSITION_TARGET);
    expect(provider).toEqual({ provide: LOCK_KEEP_POSITION_TARGET, useValue: lockKeepPositionTarget });
    const ids = fixture.document.sections.flatMap((section) => section.blocks.map((block) => block.id));
    expect(ids).toContain('violet-eye');
    expect(ids).not.toContain('violet-eye-cones');
    const projection = await read(person, fixture.ref);
    expect(projection).toEqual({ kind: 'scroll', topLevelBlockIds: ids });
    const encoded = JSON.stringify(projection);
    for (const secret of [
      'violet-eye-cones',
      'document',
      'title',
      'source',
      'provenance',
      'topic',
      'exposure',
      'capabilities',
      'position',
    ]) {
      expect(encoded).not.toContain(secret);
    }
  });

  it('reads the exact validated Reel duration/media binding, with no reading-facts estimate or media key in output', async () => {
    const person = await seedPerson(database.db),
      fixture = await reel();
    expect(await read(person, fixture.ref)).toEqual({ kind: 'reel', durationMs: 25789 });
    expect(await read(person, { ...fixture.ref, assetId: fixture.ref.assetId.toUpperCase() })).toEqual({
      kind: 'reel',
      durationMs: 25789,
    });
    await database.db
      .updateTable('content.media_objects')
      .set({ logical_key: `sha256/ff/${'f'.repeat(64)}.mp4` })
      .where('id', '=', fixture.mediaId)
      .execute();
    expect(await read(person, fixture.ref)).toBeUndefined();
    const orphan = await reel();
    await database.db.deleteFrom('content.reel_imports').where('asset_id', '=', orphan.ref.assetId).execute();
    expect(await read(person, orphan.ref)).toBeUndefined();
  });

  it('refuses malformed/extra refs, mismatched owner context and non-account actors without opening another authority gate', async () => {
    const person = await seedPerson(database.db),
      fixture = await reel();
    for (const ref of [
      { ...fixture.ref, assetRevision: '1' },
      { ...fixture.ref, assetRevision: 0 },
      { ...fixture.ref, assetRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...fixture.ref, assetId: 'bad' },
      { ...fixture.ref, secret: 'rejected-key-canary' },
      [],
      null,
    ])
      expect(await read(person, ref)).toBeUndefined();
    await scope()(person.authority, async (sc) => {
      const owner = await fenced(sc);
      for (const bad of [
        { ...owner, accountId: randomUUID() },
        { ...owner, universeId: randomUUID() },
        { ...owner, privacyEpoch: owner.privacyEpoch + 1 },
      ])
        expect(await lockKeepPositionTarget(sc, bad, fixture.ref)).toBeUndefined();
    });
    await scope()({ ...person.authority, actor: { kind: 'system', purpose: 'ci-no-account-bypass' } }, async (sc) => {
      const owner = await fenced(sc);
      expect(await lockKeepPositionTarget(sc, owner, fixture.ref)).toBeUndefined();
    });
  });

  it('rejects a closed scope even with a retained matching AccountAccess snapshot', async () => {
    const person = await seedPerson(database.db),
      fixture = await reel();
    let retained: { scope: PersonalScopeTx; owner: AccountAccess } | undefined;
    await scope()(person.authority, async (sc) => {
      retained = { scope: sc, owner: await fenced(sc) };
    });
    if (!retained) throw new Error('CI scope was not captured');
    await expect(lockKeepPositionTarget(retained.scope, retained.owner, fixture.ref)).rejects.toMatchObject({
      code: 'SCOPE_CLOSED',
    });
  });

  it('coarsely refuses missing/withdrawn/corrected/missing-revision/unsupported or malformed canonical documents', async () => {
    const person = await seedPerson(database.db);
    expect(await read(person, { assetId: randomUUID(), assetRevision: 1 })).toBeUndefined();
    const missing = await reel();
    await database.db
      .updateTable('content.assets')
      .set({ revision: 2 })
      .where('id', '=', missing.ref.assetId)
      .execute();
    expect(await read(person, missing.ref)).toBeUndefined();
    expect(await read(person, { ...missing.ref, assetRevision: 2 })).toBeUndefined();
    const withdrawn = await reel();
    await change(withdrawn.ref.assetId, 'withdrawn');
    expect(await read(person, withdrawn.ref)).toBeUndefined();
    for (const [version, modify] of [
      ['reel-document.v2', { schemaVersion: 'reel-document.v2' }],
      ['reel-document.v1', { durationMs: -1 }],
      ['reel-document.v1', { revision: 2 }],
      ['reel-document.v1', { assetId: randomUUID() }],
      ['reel-document.v1', { privateCanary: 'not allowed' }],
    ] as const) {
      const bad = await reel();
      await database.db
        .updateTable('content.asset_revisions')
        .set({ document_version: version, document: JSON.stringify({ ...bad.document, ...modify }) })
        .where('asset_id', '=', bad.ref.assetId)
        .execute();
      expect(await read(person, bad.ref)).toBeUndefined();
    }
    const badScroll = await scroll();
    await database.db
      .updateTable('content.asset_revisions')
      .set({ document_sha256: '0'.repeat(64) })
      .where('asset_id', '=', badScroll.ref.assetId)
      .execute();
    expect(await read(person, badScroll.ref)).toBeUndefined();
    const unsealedScroll = await scroll();
    await database.db
      .updateTable('content.asset_revisions')
      .set({
        document: JSON.stringify({
          ...unsealedScroll.document,
          title: 'Changed without re-sealing the canonical document',
        }),
      })
      .where('asset_id', '=', unsealedScroll.ref.assetId)
      .execute();
    expect(await read(person, unsealedScroll.ref)).toBeUndefined();
    const wrongKind = await reel();
    await database.db
      .updateTable('content.assets')
      .set({ kind: 'scroll' })
      .where('id', '=', wrongKind.ref.assetId)
      .execute();
    expect(await read(person, wrongKind.ref)).toBeUndefined();
    const invalidScroll = await scroll();
    await database.db
      .updateTable('content.asset_revisions')
      .set({ document: JSON.stringify({ ...invalidScroll.document, schemaVersion: 'scroll-document.v2' }) })
      .where('asset_id', '=', invalidScroll.ref.assetId)
      .execute();
    expect(await read(person, invalidScroll.ref)).toBeUndefined();
  });

  it.each(['withdrawn', 'corrected'] as const)(
    'freshly refuses after waiting behind a committed %s head change',
    async (mode) => {
      const person = await seedPerson(database.db),
        fixture = await reel();
      const changed = gate(),
        release = gate();
      const mutation = withTransaction(other.db, 'ci.keep-target-change-first', async (trx) => {
        await trx
          .updateTable('content.assets')
          .set(mode === 'withdrawn' ? { status: 'withdrawn' } : { revision: 2 })
          .where('id', '=', fixture.ref.assetId)
          .execute();
        changed.open();
        await release.promise;
      });
      await changed.promise;
      const pending = read(person, fixture.ref);
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
      } finally {
        release.open();
      }
      await mutation;
      expect(await pending).toBeUndefined();
    },
  );

  it.each(['withdrawn', 'corrected'] as const)(
    'holds SHARE until the caller commits before a concurrent %s change',
    async (mode) => {
      const person = await seedPerson(database.db),
        fixture = await reel();
      const projected = gate(),
        release = gate();
      const reading = scope()(person.authority, async (sc) => {
        const result = await lockKeepPositionTarget(sc, await fenced(sc), fixture.ref);
        expect(result).toEqual({ kind: 'reel', durationMs: 25789 });
        projected.open();
        await release.promise;
        return result;
      });
      await projected.promise;
      const mutation = change(fixture.ref.assetId, mode);
      try {
        await expect.poll(waiting).toBeGreaterThan(0);
        expect(
          await database.db
            .selectFrom('content.assets')
            .select(['status', 'revision'])
            .where('id', '=', fixture.ref.assetId)
            .executeTakeFirst(),
        ).toEqual({ status: 'admitted', revision: 1 });
      } finally {
        release.open();
      }
      expect(await reading).toMatchObject({ kind: 'entered', value: { kind: 'reel', durationMs: 25789 } });
      await mutation;
      expect(await read(person, fixture.ref)).toBeUndefined();
    },
  );

  it('rolls back caller effects and releases Content SHARE when the enclosing transaction fails', async () => {
    const person = await seedPerson(database.db),
      fixture = await reel();
    await expect(
      scope()(person.authority, async (sc) => {
        expect(await lockKeepPositionTarget(sc, await fenced(sc), fixture.ref)).toEqual({
          kind: 'reel',
          durationMs: 25789,
        });
        await transactionOf(sc)
          .insertInto('experience.saved_items')
          .values({
            universe_id: person.universeId,
            asset_id: fixture.ref.assetId,
            asset_revision: 1,
            saved_at: new Date(),
          })
          .execute();
        throw new Error('CI injected post-projection rollback');
      }),
    ).rejects.toThrow('CI injected post-projection rollback');
    expect(
      await database.db
        .selectFrom('experience.saved_items')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([]);
    await change(fixture.ref.assetId, 'withdrawn');
    expect(await read(person, fixture.ref)).toBeUndefined();
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('experience.actions')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([]);
  });
});

import { instrumentKeep, keepProbeSummary, seedKeepFixture, type KeepTiming } from '../support/keep-fixture.js';
/** Serial warm Actions probes, not production percentiles or a client UX acceptance. */
describe('Keep full canonical target transaction cost (real PostgreSQL; bounded authored probes)', () => {
  let db: TestDatabase<Database>;
  beforeAll(async () => {
    db = await createTestDatabase<Database>('keep_cost');
  });
  afterAll(async () => {
    await db.drop();
  });
  it('measures a real correction queued behind the full-admission SHARE transaction', async () => {
    const f = await seedKeepFixture(db.db, 'maximal'),
      projected = gate(),
      release = gate();
    let holderPid = 0;
    const started = performance.now();
    const pending = makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 })(f.person.authority, async (sc) => {
      holderPid = (await sql<{ p: number }>`select pg_backend_pid() p`.execute(transactionOf(sc))).rows[0]!.p;
      const fenced = await accountAccessUseCases({ db: db.db, lockTimeoutMs: 5000 }).fenceOwnAccount(sc);
      if (fenced.kind !== 'active') throw new Error('CI account fence refused');
      const target = await lockKeepPositionTarget(sc, fenced.owner, f.ref);
      projected.open();
      await release.promise;
      return target;
    });
    await projected.promise;
    const correctionStarted = performance.now();
    const correction = withTransaction(db.db, 'ci.keep-share-correction', async (trx) => {
      await trx.updateTable('content.assets').set({ revision: 2 }).where('id', '=', f.ref.assetId).execute();
    });
    try {
      const deadline = performance.now() + 4000;
      let observed = false;
      while (performance.now() < deadline) {
        const r = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where datname=current_database() and ${holderPid}::int=any(pg_blocking_pids(pid))`.execute(
          db.db,
        );
        if ((r.rows[0]?.n ?? 0) > 0) {
          observed = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(observed).toBe(true);
    } finally {
      release.open();
    }
    expect(await pending).toMatchObject({ kind: 'entered', value: { kind: 'scroll' } });
    await correction;
    const correctionWaitMs = performance.now() - correctionStarted,
      transactionMs = performance.now() - started;
    expect(transactionMs).toBeLessThan(5000);
    const meter = instrumentKeep(db.db);
    expect(await meter.cases.readEntry(f.person.authority, { version: 'keep-place.v1', target: f.ref })).toMatchObject({
      kind: 'ok',
      value: { status: 'saved_unavailable' },
    });
    process.stdout.write(
      JSON.stringify({
        event: 'keep-module-lock-probe',
        kind: 'correction-after-share',
        transactionMs,
        correctionWaitMs,
        barrier: 'actual pg_blocking_pids; full canonical admission before SHARE transaction commits',
      }) + '\n',
    );
  });
  it.each(['ordinary', 'maximal', 'reel'] as const)(
    'records full read/set transaction/CPU/query/commit spans for %s',
    async (variant) => {
      const f = await seedKeepFixture(db.db, variant),
        meter = instrumentKeep(db.db);
      const position =
        variant === 'reel'
          ? { kind: 'reel' as const, positionMs: 129.25 }
          : {
              kind: 'scroll' as const,
              blockId: variant === 'maximal' ? 'sim-a' : 'violet-eye',
              offsetWithinBlock: 12.75,
            };
      const state = async () =>
        (
          await sql<{
            revision: number;
            receipts: number;
            places: number;
            evidence: number;
            exposures: number;
            actions: number;
            jobs: number;
          }>`select (select revision from identity.universes where id=${f.person.universeId}::uuid) revision,(select count(*)::int from receipts.personal_commands where universe_id=${f.person.universeId}::uuid) receipts,(select count(*)::int from experience.saved_places where universe_id=${f.person.universeId}::uuid) places,(select count(*)::int from evidence.observations where universe_id=${f.person.universeId}::uuid) evidence,(select count(*)::int from experience.exposures where universe_id=${f.person.universeId}::uuid) exposures,(select count(*)::int from experience.actions where universe_id=${f.person.universeId}::uuid) actions,(select count(*)::int from pgboss.job) jobs`.execute(
            db.db,
          )
        ).rows[0]!;
      const before = await state(),
        reads: KeepTiming[] = [],
        sets: KeepTiming[] = [];
      const read = async () => {
        const r = await meter.measure(() =>
          meter.cases.readEntry(f.person.authority, { version: 'keep-place.v1', target: f.ref }),
        );
        expect(r.value).toMatchObject({ kind: 'ok', value: { status: 'available' } });
        return r.timing;
      };
      const coldRead = await read();
      for (let n = 0; n < 3; n++) await read();
      for (let n = 0; n < 20; n++) reads.push(await read());
      expect(await state()).toEqual(before);
      let revision = 0;
      const set = async () => {
        const r = await meter.measure(() =>
          meter.cases.setPlace(f.person.authority, {
            version: 'keep-place.v1',
            commandId: randomUUID(),
            entry: f.entry,
            expectedPlaceRevision: revision,
            position,
          }),
        );
        expect(r.value).toMatchObject({
          kind: 'ok',
          value: { basePlaceRevision: revision, acceptedPlaceRevision: revision + 1 },
        });
        revision++;
        return r.timing;
      };
      const coldSet = await set();
      for (let n = 0; n < 3; n++) await set();
      for (let n = 0; n < 20; n++) sets.push(await set());
      expect(await state()).toEqual({
        ...before,
        revision: before.revision + 24,
        receipts: before.receipts + 24,
        places: before.places + 1,
      });
      for (const timing of [coldRead, coldSet, ...reads, ...sets]) {
        expect(timing.wallMs).toBeLessThan(5000);
        expect(timing.txWallMs).toBeGreaterThan(0);
        expect(timing.targetCpuMs).toBeGreaterThan(0);
        expect(timing.phases.some((p) => p.phase === 'asset-share')).toBe(true);
        expect(timing.phases.some((p) => p.phase === 'canonical-document')).toBe(true);
      }
      const pg = (await sql<{ version: string }>`select current_setting('server_version') version`.execute(db.db))
        .rows[0]!.version;
      process.stdout.write(
        JSON.stringify({
          event: 'keep-module-latency-probe',
          fixture: 'authored-canonical-only',
          variant,
          node: process.versions.node,
          pg,
          runner: process.env['RUNNER_OS'] ?? 'unknown',
          documentBytes: f.documentBytes,
          documentSha256: f.documentSha256,
          warmups: 3,
          sampleSize: 20,
          coldRead,
          coldSet,
          reads,
          sets,
          readSummary: keepProbeSummary(reads.map((s) => s.wallMs)),
          setSummary: keepProbeSummary(sets.map((s) => s.wallMs)),
          limits:
            'existing scope lock5000ms; full canonical admission unchanged; bounded probe, not production percentile/UX acceptance',
          timingMeaning:
            'CPU is this process; target includes full proof plus SQL; commitAckSpan includes commit/driver return; query spans include lock waits',
        }) + '\n',
      );
    },
  );
});
