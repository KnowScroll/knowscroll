import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  makeCommission,
  postgresCommissionStore,
  lockCommissionBusiness,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  cutroomBFor,
  makeEnqueueCutroom,
  postgresCutroomLedger,
  type CutroomBPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { cutroomPoolQueue, type CutroomScopeTx } from '@knowscroll/backend/reasoning';
import { seedPerson } from '../support/fixtures.js';
import { commissionFixture, hash, type CommissionFixture } from '../support/commission-fixture.js';
import { gate } from '../support/fixture-model.js';

describe('Content public commission B (real world PG/pg-boss; fictional script, no provider)', () => {
  let f: CommissionFixture;
  beforeAll(async () => {
    f = await commissionFixture('content');
  });
  afterAll(async () => {
    await f.close();
  });
  async function counts() {
    return (
      await sql`select
  (select count(*) from content.reel_commissions) as business,
  (select count(*) from reasoning.cutroom_attempts) as attempts,
  (select count(*) from reasoning.cutroom_requests) as requests,
  (select count(*) from reasoning.cutroom_pool_operations) as operations,
  (select count(*) from pgboss.job where name='reasoning.cutroom-pool') as jobs`.execute(f.world.db)
    ).rows[0];
  }
  it('default disabled/empty owner registry, missing root and spoofed references create no rows or pool calls', async () => {
    const c = f.command('deny'),
      before = await counts();
    const disabled = cutroomBFor(f.world.db, f.boss);
    expect(await f.commission(disabled)(c.input)).toEqual({ kind: 'refused', code: 'disabled' });
    expect(await f.commission(f.service({ approvals: [] }))(c.input)).toEqual({ kind: 'refused', code: 'authority' });
    expect(
      await f.commission()({
        ...c.input,
        approvalReference: { ...c.input.approvalReference, ref: 'caller-not-human-approval' },
      }),
    ).toEqual({ kind: 'refused', code: 'authority' });
    await f.world.db.deleteFrom('reasoning.cutroom_scopes').where('world_id', '=', 'dev').execute();
    expect(await f.commission()(c.input)).toEqual({ kind: 'refused', code: 'disabled' });
    await f.world.db
      .insertInto('reasoning.cutroom_scopes')
      .values({ world_id: 'dev', generation: 1, enabled: true })
      .execute();
    expect(await counts()).toEqual(before);
    expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
  });
  it('atomically persists one approved candidate/business/exact request/intention/job; immutable replay allocates nothing', async () => {
    const c = f.command('atomic'),
      before = await counts(),
      b = f.actual(),
      request = f.commission(b);
    const result = await request(c.input);
    expect(result).toMatchObject({ kind: 'pending', state: 'reserved', poolState: 'pending' });
    expect(await request(c.input)).toEqual(result);
    expect(await counts()).toEqual(
      Object.fromEntries(Object.entries(before!).map(([k, v]) => [k, String(Number(v) + 1)])),
    );
    const row = await f.world.db
      .selectFrom('reasoning.cutroom_requests')
      .selectAll()
      .where('request_sha256', '=', c.prepared.requestSha256)
      .executeTakeFirstOrThrow();
    expect(row.request_utf8).toBe(c.prepared.requestUtf8);
    expect(row.byte_length).toBe(Buffer.byteLength(c.prepared.requestUtf8, 'utf8'));
    expect(row.byte_length).toBeGreaterThan(c.prepared.requestUtf8.length);
    const jobs = await sql<{
      data: object;
    }>`select data from pgboss.job where name='reasoning.cutroom-pool' and data->>'attemptId'=${row.attempt_id}`.execute(
      f.world.db,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(Object.keys(jobs.rows[0]!.data).sort()).toEqual(['attemptId', 'generation', 'operationId', 'v', 'worldId']);
    expect(JSON.stringify(jobs.rows)).not.toContain('requestUtf8');
    expect(JSON.stringify(jobs.rows)).not.toContain('narration');
    expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
  });
  it('does not reinterpret changed script/evidence/take/approval/world or arbitrary personal input as the same business', async () => {
    const c = f.command('identity');
    expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    const before = await counts();
    const changed = structuredClone(c.input);
    changed.script.title += ' changed';
    for (const input of [
      changed,
      { ...c.input, take: 2 },
      { ...c.input, principalName: 'different-session' },
      { ...c.input, approvalReference: { ...c.input.approvalReference, ref: 'other' } },
    ])
      expect(await f.commission()(input)).toEqual({ kind: 'held', code: 'identity' });
    expect(await f.commission()({ ...c.input, privateContext: 'personal-canary' })).toEqual({
      kind: 'refused',
      code: 'invalid',
    });
    expect(await f.commission()({ ...c.input, authority: { worldId: 'foreign', generation: 1 } })).toEqual({
      kind: 'refused',
      code: 'invalid',
    });
    expect(await counts()).toEqual(before);
  });
  it.each(['business', 'request', 'job', 'binding'] as const)(
    'rolls back all world stores and required job after injected %s failure',
    async (stage) => {
      const c = f.command(`rollback-${stage}`),
        before = await counts();
      const enqueue = makeEnqueueCutroom(f.boss),
        ledger = postgresCutroomLedger(async (...args) => {
          await enqueue(...args);
          if (stage === 'job') throw new Error('CI after job');
        });
      const hooked: Partial<CutroomBPorts> = {
        ledger:
          stage === 'request'
            ? {
                ...ledger,
                reserve: async (...args) => {
                  await ledger.reserve(...args);
                  throw new Error('CI after request');
                },
              }
            : ledger,
      };
      const b = f.service(hooked),
        store = {
          ...postgresCommissionStore,
          insert: async (...args: Parameters<typeof postgresCommissionStore.insert>) => {
            const inserted = await postgresCommissionStore.insert(...args);
            if (stage === 'business') throw new Error('CI after business');
            return inserted;
          },
          bind: async (...args: Parameters<typeof postgresCommissionStore.bind>) => {
            await postgresCommissionStore.bind(...args);
            if (stage === 'binding') throw new Error('CI after binding');
          },
        };
      const request = makeCommission({ reasoning: b, store, sha256: hash });
      await expect(request(c.input)).rejects.toThrow('CI after');
      expect(await counts()).toEqual(before);
      expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    },
  );
  it('snapshots the exact admitted candidate before a business-lock await; caller mutation cannot change protected bytes', async () => {
    const c = f.command('candidate-alias'),
      held = gate(),
      release = gate();
    const candidate = {
      ...c.approval,
      contractVersion: 1 as const,
      requestUtf8: c.prepared.requestUtf8,
      byteLength: c.prepared.byteLength,
    };
    const b = f.service({
      lockBusiness: async (scope, id) => {
        const valid = await lockCommissionBusiness(scope, id);
        held.open();
        await release.promise;
        return valid;
      },
    });
    const pending = b.withScope(c.input.authority, 'admit', async (scope) => {
      expect(
        await postgresCommissionStore.insert(
          scope,
          candidate,
          hash('fictional-command'),
          JSON.stringify(c.input.script),
        ),
      ).toBe(true);
      const result = await b.reserve(scope, candidate);
      if (result.kind === 'pending') await postgresCommissionStore.bind(scope, c.input.businessRunId, result.attemptId);
      return result;
    });
    await held.promise;
    candidate.requestUtf8 += ' ';
    candidate.requestSha256 = hash(candidate.requestUtf8);
    candidate.byteLength = Buffer.byteLength(candidate.requestUtf8, 'utf8');
    release.open();
    expect(await pending).toMatchObject({ kind: 'entered', value: { kind: 'pending' } });
    const request = await f.world.db
      .selectFrom('reasoning.cutroom_requests')
      .selectAll()
      .where('request_sha256', '=', c.prepared.requestSha256)
      .executeTakeFirstOrThrow();
    expect(request.request_utf8).toBe(c.prepared.requestUtf8);
  });
  it('concurrent duplicates produce exactly one immutable business/attempt/request/operation/job', async () => {
    const c = f.command('duplicate'),
      before = await counts();
    const [a, b] = await Promise.all([f.commission()(c.input), f.commission()(c.input)]);
    expect(a.kind).toBe('pending');
    expect(b).toEqual(a);
    expect(await counts()).toEqual(
      Object.fromEntries(Object.entries(before!).map(([k, v]) => [k, String(Number(v) + 1)])),
    );
  });
  it('rechecks disabled generation after root wait; registry mutation cannot create authority', async () => {
    const c = f.command('root-wait'),
      b = f.actual(),
      held = gate(),
      release = gate();
    const tx = f.world.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('reasoning.cutroom_scopes')
        .set({ generation: 2, enabled: false })
        .where('world_id', '=', 'dev')
        .execute();
      held.open();
      await release.promise;
    });
    await held.promise;
    const pending = f.commission(b)(c.input);
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                f.world.db,
              )
            ).rows[0]!.n,
          ),
        )
        .toBeGreaterThan(0);
    } finally {
      release.open();
    }
    await tx;
    expect(await pending).toMatchObject({ kind: 'refused' });
    await f.world.db
      .updateTable('reasoning.cutroom_scopes')
      .set({ generation: 1, enabled: true })
      .where('world_id', '=', 'dev')
      .execute();
    const empty: typeof f.approvals = [],
      snap = f.service({ approvals: empty });
    empty.push(c.approval);
    expect(await f.commission(snap)(c.input)).toEqual({ kind: 'refused', code: 'authority' });
  });
  it('forged or closed scope never gains a world transaction; scoped enqueue shares real rollback/lifetime', async () => {
    const c = f.command('scope'),
      b = f.actual();
    expect(await f.commission(b)(c.input)).toMatchObject({ kind: 'pending' });
    let closed: CutroomScopeTx | undefined;
    await b.withScope(c.input.authority, 'recover', (sc) => {
      closed = sc;
      return Promise.resolve();
    });
    const enqueue = makeEnqueueCutroom(f.boss);
    // Intentional test-only forged brands prove the private runtime map, never production authority.
    for (const scope of [closed!, { authority: c.input.authority, mode: 'admit', enabled: true } as CutroomScopeTx])
      await expect(
        enqueue(scope, cutroomPoolQueue, {
          v: 1,
          worldId: 'dev',
          generation: 1,
          attemptId: '00000000-0000-4000-8000-000000000001',
          operationId: '00000000-0000-4000-8000-000000000002',
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
  });
  it('actual personal epoch invalidation/full erasure leaves shared public business/requests/pool accounting untouched', async () => {
    const c = f.command('personal-clear');
    expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    const before = await counts(),
      orders = (await f.owner.query('select to_jsonb(o) from public.pool_order o')).rows;
    const person = await seedPerson(f.world.db),
      access = accountAccessUseCases({ db: f.world.db, lockTimeoutMs: 5000 });
    expect(await access.invalidateOwnAccountAccess(person.authority, 'advance_epoch')).toMatchObject({
      kind: 'entered',
    });
    await makeWithPersonalScope(f.world.db, { lockTimeoutMs: 5000 })(
      { ...person.authority, privacyEpoch: 2 },
      async (scope) => eraseUniverse(scope, personalStores),
    );
    expect(await counts()).toEqual(before);
    expect((await f.owner.query('select to_jsonb(o) from public.pool_order o')).rows).toEqual(orders);
  });
});
