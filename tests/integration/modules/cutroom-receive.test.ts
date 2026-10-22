/** Actions-only real PG/media fixtures. Root bindings are authored test data, never approvals. */
import { randomUUID } from 'node:crypto';
import { appendFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeWithCutroomReceiveScope,
  cutroomReceiveTransactionOf,
  makeWithPersonalScope,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  makeWithCutroomScope,
  makeWithCutroomPreparationScope,
  postgresCutroomSettlement,
  makeEnqueueCutroom,
  makeEnqueueCutroomMaintenance,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  makeCommissionReceive,
  postgresCommissionReceive,
  postgresCommissionReceiveOrigin,
} from '@knowscroll/backend/modules/content/nest-providers';
import { makeCommissionReceiveExport } from '@knowscroll/backend/modules/content';
import type { CommissionReceivePayload, ReceiveScopeTx, WithReceiveScope } from '@knowscroll/backend/modules/content';
import { seedPerson } from '../support/fixtures.js';
import { receiveFixture, receiveVariant, receiveHash } from '../support/commission-receive-fixture.js';

describe('CF62 separate zero-cost receiving (actual disposable PostgreSQL)', () => {
  let f: Awaited<ReturnType<typeof receiveFixture>>;
  beforeAll(async () => {
    f = await receiveFixture('core');
    expect(f.envelope).toBeDefined();
  });
  afterAll(async () => {
    await f?.close();
  });
  function variant(change: (p: CommissionReceivePayload) => void = () => {}) {
    return receiveVariant(f.envelope!, (p) => {
      p.publicationId = randomUUID();
      p.businessRunId = randomUUID();
      p.document.assetId = p.businessRunId;
      change(p);
    });
  }
  function service(withScope: WithReceiveScope = f.withScope, store = f.store, media = f.media) {
    return makeCommissionReceive({
      enabled: true,
      fixture: true,
      authority: f.authority,
      withScope,
      store,
      media,
      now: Date.now,
      readBinding: (id, digest) => {
        const b = f.bindings.get(id);
        return Promise.resolve(b?.payloadSha256 === digest ? b : undefined);
      },
    });
  }
  const work = (e: { payloadUtf8: string }) => ({
    v: 1 as const,
    worldId: 'stage' as const,
    handoffId: (JSON.parse(e.payloadUtf8) as CommissionReceivePayload).handoffId,
  });
  it('exports only exact confirmed normal settlement, preserving actual OWN costs and six fractional timestamp bytes', async () => {
    const p = JSON.parse(f.envelope!.payloadUtf8) as CommissionReceivePayload;
    expect(p.receiverChargeCents).toBe(0);
    expect(p.settlement.actualCents).toBe(34);
    expect(p.settlement.runs).toEqual(f.published.report.runs);
    expect(p.settlement.bindingId).toBe(f.published.report.poolReceipt.bindingId);
    expect(p.settlement.claimedAt).toBe(f.published.report.poolReceipt.claimedAt);
    expect(p.settlement.boundAt).toBe(f.published.report.poolReceipt.boundAt);
    expect(p.settlement.claimedAt).toMatch(/\.\d{6}Z$/);
    expect(p.settlement.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await f.exportPayload({ publicationId: f.published.published.publicationId, targetWorld: 'dev' }),
    ).toBeUndefined();
    const before = await f.origin.owner.query('select * from public.pool_v2_order order by request_id');
    expect(await f.exportPayload({ publicationId: f.published.published.publicationId, targetWorld: 'stage' })).toEqual(
      f.envelope,
    );
    expect((await f.origin.owner.query('select * from public.pool_v2_order order by request_id')).rows).toEqual(
      before.rows,
    );
  });
  it('admission is normal immutable Content, exact replay has no later effects or receiving financial records', async () => {
    const e = f.envelope!,
      p = JSON.parse(e.payloadUtf8) as CommissionReceivePayload;
    f.bind(e);
    await f.transfer(e);
    expect(await f.service.stage(e)).toEqual({ kind: 'pending' });
    const result = await f.service.receive(work(e));
    expect(result.kind).toBe('admitted');
    const before = (
      await sql<{
        rows: unknown;
      }>`select to_jsonb(r) rows from content.cutroom_receive_receipts r where handoff_id=${p.handoffId}::uuid`.execute(
        f.target.db,
      )
    ).rows;
    expect(await f.service.stage(e)).toEqual(result);
    expect(await f.service.receive(work(e))).toEqual(result);
    expect(
      (
        await sql<{
          rows: unknown;
        }>`select to_jsonb(r) rows from content.cutroom_receive_receipts r where handoff_id=${p.handoffId}::uuid`.execute(
          f.target.db,
        )
      ).rows,
    ).toEqual(before);
    expect(
      await f.target.db
        .selectFrom('content.asset_revisions')
        .selectAll()
        .where('asset_id', '=', p.document.assetId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await f.target.db
        .selectFrom('content.discovery_revisions')
        .selectAll()
        .where('asset_id', '=', p.document.assetId)
        .execute(),
    ).toHaveLength(1);
    for (const table of [
      'reasoning.cutroom_attempts',
      'reasoning.cutroom_settlements',
      'reasoning.cutroom_financial_reports',
      'content.cutroom_publications',
      'content.reel_imports',
    ])
      expect((await sql`select 1 from ${sql.table(table)}`.execute(f.target.db)).rows, table).toEqual([]);
    expect(await f.service.stage({ ...e, payloadUtf8: e.payloadUtf8 + ' ' })).toEqual({ kind: 'held' });
  });
  it('lost post-COMMIT stage acknowledgement replays exactly without another row or financial fallback', async () => {
    const e = variant();
    f.bind(e);
    let once = true;
    const lost: WithReceiveScope = async (a, m, fn) => {
      const r = await f.withScope(a, m, fn);
      if (m === 'admit' && once) {
        once = false;
        throw new Error('FIXTURE_LOST_COMMIT_ACK');
      }
      return r;
    };
    await expect(service(lost).stage(e)).rejects.toThrow('FIXTURE_LOST_COMMIT_ACK');
    expect(await f.service.stage(e)).toEqual({ kind: 'pending' });
    expect(
      (
        await sql`select 1 from content.cutroom_receive_receipts where handoff_id=${work(e).handoffId}::uuid`.execute(
          f.target.db,
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('required pg-boss send failure rolls back staging receipt, not a hidden second outbox', async () => {
    const e = variant();
    f.bind(e);
    const boss = new Proxy(f.boss, {
      get(target, key) {
        if (key === 'send') return () => Promise.reject(new Error('FIXTURE_QUEUE_FAILURE'));
        return Reflect.get(target, key) as unknown;
      },
    });
    const store = postgresCommissionReceive(f.target.db, boss, { enabled: true, ...f.authority, fixture: true });
    await expect(service(f.withScope, store).stage(e)).rejects.toThrow('FIXTURE_QUEUE_FAILURE');
    expect(
      (
        await sql`select 1 from content.cutroom_receive_receipts where handoff_id=${work(e).handoffId}::uuid`.execute(
          f.target.db,
        )
      ).rows,
    ).toEqual([]);
  });
  it('lost actual admission COMMIT acknowledgement returns the retained receipt on retry without repeating media', async () => {
    const e = variant();
    f.bind(e);
    await f.transfer(e);
    await f.service.stage(e);
    let once = true,
      calls = 0;
    const lost: WithReceiveScope = async (a, m, fn) => {
      const result = await f.withScope(a, m, fn);
      if (m === 'admit' && once) {
        once = false;
        throw new Error('FIXTURE_LOST_ADMISSION_ACK');
      }
      return result;
    };
    const media = {
      ...f.media,
      prepare: async (...args: Parameters<typeof f.media.prepare>) => {
        calls++;
        return f.media.prepare(...args);
      },
    };
    await expect(service(lost, f.store, media).receive(work(e))).rejects.toThrow('FIXTURE_LOST_ADMISSION_ACK');
    const before = (
      await sql<{
        v: unknown;
      }>`select to_jsonb(x) v from content.cutroom_receive_receipts x where handoff_id=${work(e).handoffId}::uuid`.execute(
        f.target.db,
      )
    ).rows;
    expect(await service(f.withScope, f.store, media).receive(work(e))).toMatchObject({ kind: 'admitted' });
    expect(calls).toBe(1);
    expect(
      (
        await sql<{
          v: unknown;
        }>`select to_jsonb(x) v from content.cutroom_receive_receipts x where handoff_id=${work(e).handoffId}::uuid`.execute(
          f.target.db,
        )
      ).rows,
    ).toEqual(before);
  });
  it('retains an authored original+one-child OWN-cost report exactly and rejects any total substitution', async () => {
    const e = variant((p) => {
      const run = p.settlement.runs[0]!;
      p.settlement.runs = [
        { ...run, runId: 'fixture-failed-original', status: 'failed', ownCostCents: 9 },
        { ...run, runId: 'fixture-completed-child', status: 'completed', ownCostCents: 25 },
      ];
      p.settlement.finalRunId = 'fixture-completed-child';
      p.settlement.actualCents = 34;
    });
    f.bind(e);
    await f.transfer(e);
    expect(await f.service.stage(e)).toEqual({ kind: 'pending' });
    expect(await f.service.receive(work(e))).toMatchObject({ kind: 'admitted' });
    const row = (
      await sql<{
        payload_utf8: string;
      }>`select payload_utf8 from content.cutroom_receive_receipts where handoff_id=${work(e).handoffId}::uuid`.execute(
        f.target.db,
      )
    ).rows[0]!;
    expect(row.payload_utf8).toBe(e.payloadUtf8);
    const wrong = receiveVariant(e, (p) => {
      p.settlement.actualCents = 25;
    });
    f.bind(wrong);
    expect(await f.service.stage(wrong)).toEqual({ kind: 'held' });
  });
  it('an existing asset identity cannot be adopted by a different handoff, and historical replay cannot resurrect withdrawn content', async () => {
    const base = JSON.parse(f.envelope!.payloadUtf8) as CommissionReceivePayload;
    const collision = variant((p) => {
      p.businessRunId = base.businessRunId;
      p.document.assetId = base.document.assetId;
    });
    f.bind(collision);
    await f.transfer(collision);
    await f.service.stage(collision);
    expect(await f.service.receive(work(collision))).toEqual({ kind: 'held' });
    expect(
      (
        await sql`select 1 from content.cutroom_receive_receipts where asset_id=${base.document.assetId}::uuid and state='admitted'`.execute(
          f.target.db,
        )
      ).rows,
    ).toHaveLength(1);
    await f.target.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', base.document.assetId)
      .execute();
    expect(await f.service.stage(f.envelope!)).toMatchObject({ kind: 'admitted' });
    expect(
      await f.target.db
        .selectFrom('content.assets')
        .select('status')
        .where('id', '=', base.document.assetId)
        .executeTakeFirst(),
    ).toEqual({ status: 'withdrawn' });
    await f.target.db
      .updateTable('content.assets')
      .set({ status: 'admitted' })
      .where('id', '=', base.document.assetId)
      .execute();
    await f.origin.world.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', base.document.assetId)
      .execute();
    try {
      expect(await f.exportPayload({ publicationId: base.publicationId, targetWorld: 'stage' })).toBeUndefined();
    } finally {
      await f.origin.world.db
        .updateTable('content.assets')
        .set({ status: 'admitted' })
        .where('id', '=', base.document.assetId)
        .execute();
    }
  });
  it('rejects mismatched hashes, self-digest, malformed identities/overage/nonvideo/extra fields before staging', async () => {
    const cases = [
      { ...f.envelope!, payloadSha256: '0'.repeat(64) },
      { payloadUtf8: 'x'.repeat(100001), payloadSha256: receiveHash('x'.repeat(100001)) },
      { ...f.envelope!, unexpected: true },
      variant((p) => {
        p.settlement.actualCents = 76;
      }),
      variant((p) => {
        p.settlement.runs[0]!.ownCostCents = 1;
      }),
      variant((p) => {
        p.settlement.runs.at(-1)!.status = 'failed';
      }),
      variant((p) => {
        p.media.key = 'https://example.invalid/private';
      }),
      variant((p) => {
        p.targetWorld = 'dev';
      }),
    ];
    const raw = {
        ...(JSON.parse(f.envelope!.payloadUtf8) as Record<string, unknown>),
        payloadSha256: f.envelope!.payloadSha256,
      },
      utf8 = JSON.stringify(raw);
    cases.push({ payloadUtf8: utf8, payloadSha256: receiveHash(utf8) });
    const before = (await sql`select 1 from content.cutroom_receive_receipts`.execute(f.target.db)).rows.length;
    for (const e of cases) {
      try {
        f.bind(e);
      } catch {
        /* Malformed bytes cannot even describe a Root binding. */
      }
      expect(await f.service.stage(e)).toEqual({ kind: 'held' });
    }
    expect((await sql`select 1 from content.cutroom_receive_receipts`.execute(f.target.db)).rows).toHaveLength(before);
  });
  it('refuses missing/stale/future Root binding and immutable original30day deadline without reissuing', async () => {
    const missing = variant();
    expect(await f.service.stage(missing)).toEqual({ kind: 'held' });
    const future = variant(),
      b = f.bind(future);
    b.observedAtMs = Date.now() + 1000;
    b.expiresAtMs = b.observedAtMs + 1000;
    expect(await f.service.stage(future)).toEqual({ kind: 'held' });
    const expired = variant((p) => {
      p.settlement.claimedAt = '2000-01-01T00:00:00.123456Z';
      p.settlement.boundAt = '2000-01-01T00:00:00.654321Z';
    });
    f.bind(expired);
    expect(await f.service.stage(expired)).toEqual({ kind: 'held' });
  });
  it('verifies local bytes and symlinks, never reads engine/provider or accepts a filename as proof', async () => {
    const e = variant();
    f.bind(e);
    await f.transfer(e);
    expect(await f.service.stage(e)).toEqual({ kind: 'pending' });
    const p = JSON.parse(e.payloadUtf8) as CommissionReceivePayload,
      path = join(f.stagingRoot, p.handoffId, `${p.media.sha256}.mp4`);
    await appendFile(path, 'corrupt');
    expect(await f.service.receive(work(e))).toEqual({ kind: 'held' });
    expect(
      await f.target.db
        .selectFrom('content.assets')
        .select('id')
        .where('id', '=', p.document.assetId)
        .executeTakeFirst(),
    ).toBeUndefined();
    await unlink(path);
    await symlink(join(f.published.media.mediaRoot, p.media.key), path);
    expect(await f.service.receive(work(e))).toEqual({ kind: 'held' });
  });
  it('rechecks Root expiry after real media preparation, consuming no expired admission', async () => {
    const e = variant();
    const binding = f.bind(e);
    await f.transfer(e);
    await f.service.stage(e);
    const media = {
      ...f.media,
      prepare: async (...args: Parameters<typeof f.media.prepare>) => {
        const proof = await f.media.prepare(...args);
        binding.expiresAtMs = Date.now() - 1;
        return proof;
      },
    };
    expect(await service(f.withScope, f.store, media).receive(work(e))).toEqual({ kind: 'held' });
    expect(
      await f.target.db
        .selectFrom('content.assets')
        .select('id')
        .where('id', '=', (JSON.parse(e.payloadUtf8) as CommissionReceivePayload).document.assetId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
  it('separate live capability refuses copied/closed, paid/preparation and personal scope objects', async () => {
    let retained: ReceiveScopeTx | undefined;
    await f.withScope(f.authority, 'recover', (s) => {
      retained = s;
      expect(() => cutroomReceiveTransactionOf({ ...s })).toThrow();
      return Promise.resolve();
    });
    expect(() => cutroomReceiveTransactionOf(retained!)).toThrow();
    await makeWithCutroomScope(f.origin.world.db, { enabled: true, lockTimeoutMs: 1000 })(
      { worldId: 'dev', generation: 1 },
      'recover',
      (s) => {
        expect(() => cutroomReceiveTransactionOf(s)).toThrow();
        return Promise.resolve();
      },
    );
    await makeWithCutroomPreparationScope(f.origin.world.db, { enabled: true })(
      { worldId: 'dev', generation: 1 },
      (s) => {
        expect(() => cutroomReceiveTransactionOf(s)).toThrow();
        return Promise.resolve();
      },
    );
    const person = await seedPerson(f.target.db);
    await makeWithPersonalScope(f.target.db, { lockTimeoutMs: 1000 })(person.authority, (s) => {
      expect(() => cutroomReceiveTransactionOf(s)).toThrow();
      return Promise.resolve();
    });
    expect(
      await makeWithCutroomReceiveScope<ReceiveScopeTx>(f.target.db, { lockTimeoutMs: 1000 })(
        f.authority,
        'admit',
        () => Promise.resolve(true),
      ),
    ).toEqual({ kind: 'refused', code: 'disabled' });
  });
  it('cannot perform media I/O while a real receiving transaction is open', async () => {
    const p = JSON.parse(f.envelope!.payloadUtf8) as CommissionReceivePayload;
    await expect(
      f.withScope(f.authority, 'admit', async () => f.media.prepare(p, f.bind(f.envelope!))),
    ).rejects.toMatchObject({ name: 'NetworkInTransactionError' });
  });
  it('fixed-ceiling recovery commits continuation before25busy rows, reaches tail, caps waves and terminates final page', async () => {
    await sql`update content.cutroom_receive_receipts set state='expired',lease_id=null,lease_until=null where state='pending'`.execute(
      f.target.db,
    );
    const ids: string[] = [];
    for (let i = 0; i < 28; i++) {
      const e = variant();
      f.bind(e);
      await f.service.stage(e);
      ids.push(work(e).handoffId);
    }
    ids.sort();
    await sql`delete from pgboss.job where name in ('content.receive-cutroom','content.recover-receive-cutroom')`.execute(
      f.target.db,
    );
    await sql`update content.cutroom_receive_receipts set next_at=clock_timestamp()-interval '1 second' where state='pending'`.execute(
      f.target.db,
    );
    const lock = await f.target.pool.connect();
    await lock.query('begin');
    try {
      await lock.query(
        'select handoff_id from content.cutroom_receive_receipts where handoff_id=any($1::uuid[]) for update',
        [ids.slice(0, 25)],
      );
      expect(await f.service.recover({ v: 1 })).toEqual({ scanned: 25, woken: 0 });
      const page = (
        await sql<{
          data: { v: 1; worldId: 'stage'; afterId: string; throughId: string };
        }>`select data from pgboss.job where name='content.recover-receive-cutroom' and data->>'afterId'=${ids[24]!}`.execute(
          f.target.db,
        )
      ).rows[0]!.data;
      expect(page.throughId).toBe(ids[27]);
      expect(await f.service.recover(page)).toEqual({ scanned: 3, woken: 3 });
      expect(
        (
          await sql`select 1 from pgboss.job where name='content.recover-receive-cutroom' and data->>'afterId'=${ids[27]!}`.execute(
            f.target.db,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await lock.query('rollback');
      lock.release();
    }
    await sql`delete from pgboss.job where name='content.receive-cutroom'`.execute(f.target.db);
    await sql`update content.cutroom_receive_receipts set recoveries=3,next_at=clock_timestamp()-interval '1 second' where state='pending'`.execute(
      f.target.db,
    );
    expect(await f.service.recover({ v: 1 })).toEqual({ scanned: 25, woken: 0 });
    expect(
      (await sql`select 1 from pgboss.job where name='content.receive-cutroom'`.execute(f.target.db)).rows,
    ).toEqual([]);
  }, 30000);
  it('root disable/generation change during an actual lock wait refuses all pending admission', async () => {
    const e = variant();
    f.bind(e);
    const client = await f.target.pool.connect();
    await client.query('begin');
    try {
      await client.query("select world_id from content.cutroom_receiving_state where world_id='stage' for update");
      const waiting = f.service.stage(e);
      let observedWait = false;
      for (let i = 0; i < 100; i++) {
        const blocked = await client.query(
          "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()",
        );
        if (blocked.rowCount) {
          observedWait = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      await client.query(
        "update content.cutroom_receiving_state set enabled=false,generation=2 where world_id='stage'",
      );
      await client.query('commit');
      expect(await waiting).toEqual({ kind: 'held' });
      expect(observedWait).toBe(true);
      expect(
        (
          await sql`select 1 from content.cutroom_receive_receipts where handoff_id=${work(e).handoffId}::uuid`.execute(
            f.target.db,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
  it('current readonly origin metadata may export an old settled publication after paid disable/new generation, with no financial mutation', async () => {
    await f.origin.world.db
      .updateTable('reasoning.cutroom_scopes')
      .set({ enabled: false, generation: 2 })
      .where('world_id', '=', 'dev')
      .execute();
    expect(
      await f.exportPayload({ publicationId: f.published.published.publicationId, targetWorld: 'stage' }),
    ).toBeUndefined();
    const financial = postgresCutroomSettlement(
      makeEnqueueCutroom(f.origin.boss),
      makeEnqueueCutroomMaintenance(f.origin.boss),
    );
    const exportPayload = makeCommissionReceiveExport(
      postgresCommissionReceiveOrigin({
        authority: { worldId: 'dev', generation: 2 },
        withScope: makeWithCutroomPreparationScope(f.origin.world.db, { enabled: true }),
        financial,
        source: { commit: 'a'.repeat(40), artifactSha256: receiveHash('fixture-archive'), schemaVersion: 39 },
        fixture: true,
      }),
    );
    const before = (await f.origin.owner.query('select * from public.pool_v2_order order by request_id')).rows;
    expect(await exportPayload({ publicationId: f.published.published.publicationId, targetWorld: 'stage' })).toEqual(
      f.envelope,
    );
    expect((await f.origin.owner.query('select * from public.pool_v2_order order by request_id')).rows).toEqual(before);
  });
});

describe('origin cannot export an unsettled publication', () => {
  it('held/pending normal settlement is not a zero-cost handoff', async () => {
    const f = await receiveFixture('pending', { confirm: false });
    try {
      expect(f.envelope).toBeUndefined();
      expect(
        await f.exportPayload({ publicationId: f.published.published.publicationId, targetWorld: 'stage' }),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 30000);
});
