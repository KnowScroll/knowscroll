import { sql } from 'kysely';
import { rename, symlink, unlink, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeCutroomChainSnapshotCollector,
  financialReportOfSnapshot,
  makeCommissionMedia,
} from '@knowscroll/backend/modules/content/nest-providers';
import { CUTROOM_CHAIN_UPSTREAM_REVISION } from '@knowscroll/backend/modules/content';
import { createBoss, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import { cutroomSettleQueue } from '@knowscroll/backend/reasoning';
import {
  commissionFixture,
  fixturePublishedCommission,
  type CommissionFixture,
} from '../support/commission-fixture.js';
// Real isolated world/pool DB, actual local synthetic H264/AAC probe and fsync; no provider.
describe('verified connected public admission and exact settlement', () => {
  let f: CommissionFixture | undefined;
  let x: Awaited<ReturnType<typeof fixturePublishedCommission>> | undefined;
  afterEach(async () => {
    await x?.close();
    await f?.close();
    x = undefined;
    f = undefined;
  });
  it('publishes once, retains human/media provenance, settles exact actual once and historical delivery cannot erase or reopen', async () => {
    f = await commissionFixture('publication');
    x = await fixturePublishedCommission(f, 'publication');
    expect(await x.financial.process(x.c.target, x.published.operationId)).toBe('confirmed');
    expect(await x.financial.process(x.c.target, x.published.operationId)).toBe('confirmed');
    const rows = await f.world.db.selectFrom('content.assets').select(['id', 'kind', 'status']).execute();
    expect(rows).toEqual([{ id: x.c.target.businessRunId, kind: 'reel', status: 'admitted' }]);
    expect((await f.owner.query('select state,ceiling_cents,spent_cents from public.pool_order')).rows).toEqual([
      { state: 'settled', ceiling_cents: 75, spent_cents: 34 },
    ]);
    expect(
      (
        await f.owner.query(
          'select count(*)::int n,bool_and(satisfied) satisfied from public.pool_v2_settlement_evidence',
        )
      ).rows[0],
    ).toEqual({ n: 1, satisfied: true });
    const provenance = await f.world.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', x.published.assetId)
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({
      humanEvidenceRef: 'fixture-human-only',
      actualCents: 34,
      fixture: true,
    });
    const replay = await x.publication.publish(x.c.input.authority, x.c.target, {
      snapshotId: x.snapshot.snapshotId,
      snapshotSha256: x.snapshot.snapshotSha256,
    });
    expect(replay).toEqual(x.published);
    expect(
      (await sql<{ n: number }>`select count(*)::int n from content.cutroom_publications`.execute(f.world.db)).rows[0]!
        .n,
    ).toBe(1);
    expect(
      await f.world.db
        .selectFrom('content.discovery_revisions')
        .select('asset_id')
        .where('asset_id', '=', x.published.assetId)
        .execute(),
    ).toHaveLength(1);
  });
  it('cannot commit publication without its required immutable settlement or forge a confirmed receipt', async () => {
    f = await commissionFixture('publicationrollback');
    x = await fixturePublishedCommission(f, 'rollback');
    await expect(
      sql`update reasoning.cutroom_settlements set state='confirmed' where id=${x.published.operationId}::uuid`.execute(
        f.world.db,
      ),
    ).rejects.toThrow('cutroom_settlement_incomplete');
    await expect(
      sql`delete from content.cutroom_publications where id=${x.published.publicationId}::uuid`.execute(f.world.db),
    ).rejects.toThrow('cutroom_execution_immutable');
    expect((await f.owner.query('select state,spent_cents from public.pool_order')).rows[0]).toEqual({
      state: 'claimed',
      spent_cents: null,
    });
  });
  it('recovers a lost contradictory late hold after normal completion without reopening GET maintenance or changing old spend/media', async () => {
    f = await commissionFixture('latefinancial');
    x = await fixturePublishedCommission(f, 'latefinancial');
    expect(await x.financial.process(x.c.target, x.published.operationId)).toBe('confirmed');
    const old = (await f.owner.query<{ row: unknown }>('select to_jsonb(o) row from public.pool_order o')).rows[0]!.row;
    const marker = (
      await sql<{
        stopped_at: Date;
      }>`select stopped_at from reasoning.cutroom_maintenance where attempt_id=${x.c.target.attemptId}::uuid`.execute(
        f.world.db,
      )
    ).rows[0]!;
    x.media.result.costCents = 35;
    const now = Date.now();
    const collected = await makeCutroomChainSnapshotCollector({
      enabled: true,
      origin: x.media.origin,
      profile: {
        upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
        soleWriterEvidenceSha256: x.c.preflight.soleWriterEvidenceSha256,
        observedAtMs: now - 1,
        expiresAtMs: now + 29999,
      },
    }).collect(x.c.expected);
    if (collected.kind !== 'collected') throw new Error('FIXTURE_LATE_COLLECTION');
    const stored = await x.snapshots.recordCollectedChain(x.c.target, collected.snapshot);
    if (stored.kind === 'refused') throw new Error('FIXTURE_LATE_STORE');
    const snapshot = await x.snapshots.readSnapshot(x.c.target, {
      snapshotId: stored.snapshotId,
      snapshotSha256: stored.snapshotSha256,
    });
    if (snapshot.kind !== 'snapshot') throw new Error('FIXTURE_LATE_READ');
    const id = await x.financial.recordHold(x.c.target, snapshot.snapshotId, financialReportOfSnapshot(snapshot));
    expect(id).toBeTruthy();
    // Explicitly authored exhausted/lost fixture states; production code never authors them.
    await sql`update pgboss.job set state='failed',completed_on=clock_timestamp() where data->>'attemptId'=${x.c.target.attemptId} and state in ('created','retry')`.execute(
      f.world.db,
    );
    await sql`update reasoning.cutroom_financial_reports set hold_next_at=clock_timestamp()-interval '1 minute' where id=${id}::uuid`.execute(
      f.world.db,
    );
    expect(await x.maintenance.recover({ v: 1 })).toEqual({ scanned: 1, woken: 1 });
    const consumer = createBoss(f.world.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await consumer.start();
    try {
      await startConsumers(
        consumer,
        [
          jobConsumer(
            { ...cutroomSettleQueue, consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 } },
            async (p) => {
              await x!.financial.process(
                { worldId: p.worldId, businessRunId: p.businessRunId, attemptId: p.attemptId },
                p.operationId,
              );
            },
          ),
        ],
        () => undefined,
      );
      await expect
        .poll(
          async () =>
            (
              await sql<{
                hold_state: string;
              }>`select hold_state from reasoning.cutroom_financial_reports where id=${id}::uuid`.execute(f!.world.db)
            ).rows[0]!.hold_state,
          { timeout: 10000 },
        )
        .toBe('recorded');
    } finally {
      await consumer.stop({ graceful: false });
    }
    expect(
      (await f.owner.query<{ row: unknown }>('select to_jsonb(o) row from public.pool_order o')).rows[0]!.row,
    ).toEqual(old);
    expect(
      (
        await sql<{
          stopped_at: Date;
        }>`select stopped_at from reasoning.cutroom_maintenance where attempt_id=${x.c.target.attemptId}::uuid`.execute(
          f.world.db,
        )
      ).rows[0],
    ).toEqual(marker);
    expect(
      (
        await f.owner.query<{ n: number }>(
          'select count(*)::int n from public.pool_v2_settlement_evidence where not satisfied',
        )
      ).rows[0]!.n,
    ).toBe(1);
    expect(await x.maintenance.recover({ v: 1 })).toEqual({ scanned: 0, woken: 0 });
    expect(
      await f.world.db.selectFrom('content.assets').selectAll().where('id', '=', x.published.assetId).execute(),
    ).toHaveLength(1);
  });
  it('reverifies actual record/file, rejects symlink/empty media and copied proof, and stages only valid bytes without private paths', async () => {
    f = await commissionFixture('mediaproof');
    x = await fixturePublishedCommission(f, 'mediaproof');
    const media = makeCommissionMedia({
      enabled: true,
      origin: x.media.origin,
      artifactRoot: x.media.artifactRoot,
      mediaRoot: x.media.mediaRoot,
    });
    const original = await readFile(x.media.path),
      moved = x.media.path + '.fixture-original';
    await rename(x.media.path, moved);
    await symlink(moved, x.media.path);
    try {
      expect(await media.prepare(x.snapshot)).toBeUndefined();
    } finally {
      await unlink(x.media.path);
      await rename(moved, x.media.path);
    }
    await writeFile(x.media.path, Buffer.alloc(0));
    try {
      expect(await media.prepare(x.snapshot)).toBeUndefined();
    } finally {
      await writeFile(x.media.path, original);
    }
    const old = x.media.record.takes[0]!.used;
    x.media.record.takes[0]!.used = false;
    expect(await media.prepare(x.snapshot)).toBeUndefined();
    x.media.record.takes[0]!.used = old;
    const proof = await media.prepare(x.snapshot);
    expect(proof).toBeTruthy();
    expect(media.consume({ ...proof! }, x.snapshot)).toBeUndefined();
    const actual = media.consume(proof!, x.snapshot);
    expect(actual).toMatchObject({ probe: { fps: 24, audioHz: 48000, channels: 2, faststart: true } });
    expect(JSON.stringify(actual)).not.toContain(x.media.artifactRoot);
    expect(media.consume(proof!, x.snapshot)).toBeUndefined();
  });
});
