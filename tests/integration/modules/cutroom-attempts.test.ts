import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeEnqueueCutroom,
  postgresCutroomLedger,
  makeCutroomPool,
  type CutroomNotSent,
  type CutroomPoolOperation,
} from '@knowscroll/backend/reasoning/nest-providers';
import type { CutroomAuthority, CutroomPoolIdentity, WithCutroomScope } from '@knowscroll/backend/reasoning';
import { commissionFixture, type CommissionFixture } from '../support/commission-fixture.js';
import { gate } from '../support/fixture-model.js';

describe('Cutroom B durable handoff/recovery (real separate PG databases and genuine pool login; no provider)', () => {
  let f: CommissionFixture;
  beforeAll(async () => {
    f = await commissionFixture('attempt');
  });
  afterAll(async () => {
    await f.close();
  });
  const authority: CutroomAuthority = { worldId: 'dev', generation: 1 };
  async function reserve(tag: string) {
    const c = f.command(tag),
      b = f.actual(),
      result = await f.commission(b)(c.input);
    if (result.kind !== 'pending') throw new Error('CI reservation refused');
    return { ...c, b, attemptId: result.attemptId };
  }
  const row = async (id: string) =>
    f.world.db.selectFrom('reasoning.cutroom_attempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const orderCount = async () =>
    Number((await f.owner.query<{ n: string }>('select count(*) n from public.pool_order')).rows[0]!.n);
  it('commits an exact claim intention before any pool connection; pool confirmation never changes AttemptState to dispatched', async () => {
    const a = await reserve('claim');
    const before = await orderCount();
    expect(await a.b.claim(authority, a.attemptId)).toMatchObject({
      kind: 'pending',
      state: 'reserved',
      poolState: 'claimed',
    });
    const stored = await row(a.attemptId);
    expect(stored.binding_id).not.toBeNull();
    expect(stored.dispatch_intent_at).toBeNull();
    expect(await orderCount()).toBe(before + 1);
    expect(await a.b.claim(authority, a.attemptId)).toEqual({ kind: 'held', code: 'pending' });
    expect(await a.b.reconcile(authority, a.attemptId)).toMatchObject({
      kind: 'pending',
      state: 'reserved',
      poolState: 'claimed',
    });
    expect((await row(a.attemptId)).binding_id).toBe(stored.binding_id);
    expect(await orderCount()).toBe(before + 1);
  });
  it.each(['claimed_at', 'bound_at'] as const)(
    'preserves exact server microseconds for %s and holds same-millisecond receipt changes without replacement or release',
    async (field) => {
      const a = await reserve(`microseconds-${field}`),
        bindingId = randomUUID(),
        expected = { claimed_at: '2026-10-21T01:02:03.123456Z', bound_at: '2026-10-21T01:02:03.654321Z' },
        changed = { claimed_at: '2026-10-21T01:02:03.123457Z', bound_at: '2026-10-21T01:02:03.654322Z' };
      // Authored initial disposable pool rows. No trigger is disabled or existing immutable value edited.
      await f.owner.query(
        `insert into public.pool_order(request_id,script_digest,take,until,body_sha256,ordered_by,ceiling_cents,approval_ref,claimed_at)
         values($1,$2,1,'video',$3,'dev',1,$4,$5::timestamptz)`,
        [
          a.prepared.requestId,
          a.prepared.scriptSha256,
          a.prepared.requestSha256,
          a.prepared.approvalRef,
          expected.claimed_at,
        ],
      );
      await f.owner.query(
        `insert into public.pool_v2_order(request_id,grant_id,binding_id,bound_at) values($1,'knowscroll-v2-d018',$2,$3::timestamptz)`,
        [a.prepared.requestId, bindingId, expected.bound_at],
      );
      // The real genuine-login adapter claims the exact pre-existing order and reads its actual receipt.
      expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'pending', poolState: 'claimed' });
      const pinned = async () =>
        (
          await sql<{ claimed_at: string; bound_at: string }>`select
          to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at,
          to_char(bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at
          from reasoning.cutroom_attempts where id=${a.attemptId}::uuid`.execute(f.world.db)
        ).rows[0];
      expect(await pinned()).toEqual(expected);
      expect(await a.b.reconcile(authority, a.attemptId)).toMatchObject({ kind: 'pending', poolState: 'claimed' });
      expect(await pinned()).toEqual(expected);
      expect(new Date(expected[field]).getTime()).toBe(new Date(changed[field]).getTime());
      let releases = 0;
      const adapter = makeCutroomPool(async () => {
        const client = await f.pool.connect();
        return new Proxy(client, {
          get(_target, key) {
            if (key === 'then') return undefined;
            if (key === 'release') return () => client.release();
            if (key === 'query')
              return async (text: string, values?: unknown[]) => {
                if (text.includes('pool_v2_release_not_sent')) releases++;
                const result = await client.query<Record<string, unknown>>(text, values);
                if (text.includes('pool_v2_read_order')) {
                  expect(result.rows[0]?.[field]).toBe(expected[field]);
                  result.rows[0]![field] = changed[field]; // Adversarial receipt after a real session read.
                }
                return result;
              };
            throw new Error('CI unexpected pool-client access');
          },
        });
      });
      const bad = f.service({ pool: adapter });
      expect(await bad.reconcile(authority, a.attemptId)).toEqual({ kind: 'held', code: 'needs_operator' });
      expect(await pinned()).toEqual(expected);
      expect((await row(a.attemptId)).binding_id).toBe(bindingId);
      await a.b.reconcile(authority, a.attemptId);
      await a.b.cancel(authority, a.attemptId);
      expect(await bad.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
      expect(releases).toBe(0);
      expect(await pinned()).toEqual(expected);
      expect(
        (
          await f.owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [
            a.prepared.requestId,
          ])
        ).rows[0]!.state,
      ).toBe('claimed');
    },
  );
  it('lost world COMMIT acknowledgement stops external action and retains the exact in-flight operation', async () => {
    const a = await reserve('world-ack'),
      base = f.ports().withScope,
      before = await orderCount();
    let fail = true,
      calls = 0;
    const lost: WithCutroomScope = async (auth, mode, work) => {
      const result = await base(auth, mode, work);
      if (fail) {
        fail = false;
        throw new Error('CI world commit ACK lost');
      }
      return result;
    };
    const real = f.ports().pool,
      b = f.service({
        withScope: lost,
        pool: {
          ...real,
          claim: async (i) => {
            calls++;
            return real.claim(i);
          },
        },
      });
    await expect(b.claim(authority, a.attemptId)).rejects.toThrow('CI world commit ACK lost');
    expect(calls).toBe(0);
    expect(await orderCount()).toBe(before);
    expect(
      (
        await f.world.db
          .selectFrom('reasoning.cutroom_pool_operations')
          .selectAll()
          .where('attempt_id', '=', a.attemptId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('in_flight');
    expect(await a.b.claim(authority, a.attemptId)).toEqual({ kind: 'held', code: 'pending' });
    expect(await a.b.reconcile(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(await orderCount()).toBe(before);
  });
  it('crash before pool commit parks; lost pool commit ACK recovers the same exact order/binding, never another allowance', async () => {
    const a = await reserve('pool-before'),
      real = f.ports().pool,
      before = await orderCount();
    const prior = f.service({
      pool: {
        ...real,
        claim: () => Promise.reject(new Error('CI crash before pool call')),
      },
    });
    expect(await prior.claim(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(await orderCount()).toBe(before);
    const next = await reserve('pool-after'),
      lost = f.service({
        pool: {
          ...real,
          claim: async (i) => {
            await real.claim(i);
            throw new Error('CI pool COMMIT ACK lost');
          },
        },
      });
    expect(await lost.claim(authority, next.attemptId)).toMatchObject({ kind: 'held' });
    expect(await orderCount()).toBe(before + 1);
    const binding = (
      await f.owner.query<{ binding_id: string }>('select binding_id from public.pool_v2_order where request_id=$1', [
        next.prepared.requestId,
      ])
    ).rows[0]!.binding_id;
    expect(await next.b.reconcile(authority, next.attemptId)).toMatchObject({ kind: 'pending', poolState: 'claimed' });
    expect((await row(next.attemptId)).binding_id).toBe(binding);
    expect(await next.b.reconcile(authority, next.attemptId)).toMatchObject({ kind: 'pending' });
    expect(await orderCount()).toBe(before + 1);
  });
  it.each([false, true])(
    'real pool transaction failure afterCommit=%s at COMMIT preserves one pending identity and recovers only actual committed order',
    async (afterCommit) => {
      const a = await reserve(afterCommit ? 'real-after-commit' : 'real-before-commit'),
        before = await orderCount();
      const pool = makeCutroomPool(async () => {
        const client = await f.pool.connect();
        let fail = true;
        // Transparent genuine-login client, with one injected acknowledgement failure at COMMIT.
        return new Proxy(client, {
          get(_target, key) {
            if (key === 'then') return undefined;
            if (key === 'release') return () => client.release();
            if (key === 'query')
              return async (text: string, values?: unknown[]) => {
                if (text === 'commit' && fail && !afterCommit) {
                  fail = false;
                  throw new Error('CI before real pool COMMIT');
                }
                const result = await client.query(text, values);
                if (text === 'commit' && fail && afterCommit) {
                  fail = false;
                  throw new Error('CI after real pool COMMIT');
                }
                return result;
              };
            throw new Error('CI unexpected pool-client access');
          },
        });
      });
      expect(await f.service({ pool }).claim(authority, a.attemptId)).toMatchObject({ kind: 'held' });
      expect(await orderCount()).toBe(before + (afterCommit ? 1 : 0));
      const recovered = await a.b.reconcile(authority, a.attemptId);
      expect(recovered).toMatchObject({ kind: afterCommit ? 'pending' : 'held' });
      expect(await orderCount()).toBe(before + (afterCommit ? 1 : 0));
      expect((await row(a.attemptId)).take).toBe(1);
    },
  );
  it('lost local confirmation acknowledgement and concurrent duplicate delivery retain one order/binding', async () => {
    const a = await reserve('local-ack'),
      base = f.ports().withScope,
      before = await orderCount();
    let scopes = 0;
    const lost: WithCutroomScope = async (auth, mode, work) => {
      const result = await base(auth, mode, work);
      if (++scopes === 2) throw new Error('CI local confirmation ACK lost');
      return result;
    };
    await expect(f.service({ withScope: lost }).claim(authority, a.attemptId)).rejects.toThrow(
      'CI local confirmation ACK lost',
    );
    expect(await orderCount()).toBe(before + 1);
    const binding = (await row(a.attemptId)).binding_id;
    const results = await Promise.all([a.b.claim(authority, a.attemptId), a.b.reconcile(authority, a.attemptId)]);
    expect(results.every((r) => r.kind === 'pending' || r.kind === 'held')).toBe(true);
    expect((await row(a.attemptId)).binding_id).toBe(binding);
    expect(await orderCount()).toBe(before + 1);
  });
  it('all immutable tuple/session expectations refuse mismatches without creating/adopting another order', async () => {
    const a = await reserve('tuple');
    expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'pending' });
    const base: CutroomPoolIdentity = a.approval,
      adapter = makeCutroomPool(() => f.pool.connect()),
      before = await orderCount();
    for (const change of [
      { requestId: 'ks-reel-' + a.prepared.scriptSha256.slice(0, 32) + '-2' },
      { scriptSha256: 'a'.repeat(64) },
      { take: 2 },
      { until: 'plan' },
      { requestSha256: 'b'.repeat(64) },
      { worldId: 'stage' },
      { ceilingCents: 74 },
      { approvalRef: 'different' },
      { grantRef: 'foreign' },
      { principalName: 'foreign' },
      { principalOid: '1' },
    ])
      expect(await adapter.read({ ...base, ...change } as CutroomPoolIdentity)).toMatchObject({ kind: 'held' });
    expect(await orderCount()).toBe(before);
    await expect(
      f.world.db
        .updateTable('reasoning.cutroom_attempts')
        .set({ request_sha256: 'f'.repeat(64) })
        .where('id', '=', a.attemptId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('grant-disabled/foreign-unbound/script conflict park the ONE candidate without take increment', async () => {
    const a = await reserve('grant-disabled'),
      before = await orderCount();
    await f.owner.query('select public.pool_v2_admin_gate(false,false)');
    expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(await orderCount()).toBe(before);
    expect((await row(a.attemptId)).take).toBe(1);
    await f.owner.query('select public.pool_v2_admin_gate(true,false)');
    const foreign = await reserve('foreign');
    await f.owner.query('select * from public.pool_claim($1,$2,1,$3,$4,$5,75,$6)', [
      foreign.prepared.requestId,
      foreign.prepared.scriptSha256,
      'video',
      foreign.prepared.requestSha256,
      'legacy',
      'fictional-reference-only',
    ]);
    expect(await foreign.b.claim(authority, foreign.attemptId)).toMatchObject({ kind: 'held' });
    expect((await row(foreign.attemptId)).binding_id).toBeNull();
    const clash = await reserve('clash');
    await f.owner.query('select * from public.pool_claim($1,$2,2,$3,$4,$5,75,$6)', [
      `ks-reel-${clash.prepared.scriptSha256.slice(0, 32)}-2`,
      clash.prepared.scriptSha256,
      'video',
      clash.prepared.requestSha256,
      'legacy',
      'fictional-reference-only',
    ]);
    expect(await clash.b.claim(authority, clash.attemptId)).toMatchObject({ kind: 'held' });
    expect((await row(clash.attemptId)).take).toBe(1);
  });
  it('SQL enforces immutable exact protected bytes/hash/length/version and a bounded purge cursor', async () => {
    const a = await reserve('bytes');
    for (const change of [
      { request_utf8: 'corrupt' },
      { byte_length: a.prepared.byteLength + 1 },
      { contract_version: 2 },
      { request_sha256: '0'.repeat(64) },
    ])
      await expect(
        f.world.db
          .updateTable('reasoning.cutroom_requests')
          .set(change)
          .where('attempt_id', '=', a.attemptId)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    for (const limit of [0, 101, 1.5, Infinity])
      await expect(a.b.purge(authority, limit)).rejects.toThrow('CUTROOM_PURGE_BOUND');
    expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'pending', state: 'reserved' });
  });
  it('purge retains immutable request identity, makes reserved irreversibly not_sent and never recompiles/replaces expired bytes', async () => {
    const a = await reserve('expiry'),
      future = () => new Date(Date.now() + 31 * 86400000);
    const expired = f.service({ ledger: postgresCutroomLedger(makeEnqueueCutroom(f.boss), future), now: future });
    expect(await expired.purge(authority)).toBeGreaterThan(0);
    const stored = await row(a.attemptId);
    expect(stored.state).toBe('not_sent');
    expect(stored.fence).toBe(2);
    const request = await f.world.db
      .selectFrom('reasoning.cutroom_requests')
      .selectAll()
      .where('attempt_id', '=', a.attemptId)
      .executeTakeFirstOrThrow();
    expect(request.request_utf8).toBeNull();
    expect(request.request_sha256).toBe(a.prepared.requestSha256);
    expect(await f.commission(expired)(a.input)).toEqual({ kind: 'held', code: 'expired' });
    expect(await expired.claim(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(await expired.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(
      await f.world.db
        .selectFrom('reasoning.cutroom_attempts')
        .select('id')
        .where('business_run_id', '=', a.input.businessRunId)
        .execute(),
    ).toEqual([{ id: a.attemptId }]);
    await expect(
      f.world.db
        .updateTable('reasoning.cutroom_requests')
        .set({ request_utf8: a.prepared.requestUtf8, purged_at: null })
        .where('attempt_id', '=', a.attemptId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('in-flight claim racing expiry stays held until exact late binding recovery; expiry alone never releases money', async () => {
    const a = await reserve('expiry-race'),
      entered = gate(),
      release = gate(),
      real = f.ports().pool;
    const waiting = f.service({
      pool: {
        ...real,
        claim: async (i) => {
          entered.open();
          await release.promise;
          return real.claim(i);
        },
      },
    });
    const pending = waiting.claim(authority, a.attemptId);
    await entered.promise;
    const future = () => new Date(Date.now() + 31 * 86400000),
      expired = f.service({ ledger: postgresCutroomLedger(makeEnqueueCutroom(f.boss), future), now: future });
    await expired.purge(authority);
    expect(await expired.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    release.open();
    expect(await pending).toMatchObject({ kind: 'held' });
    expect((await row(a.attemptId)).state).toBe('not_sent');
    expect(await expired.reconcile(authority, a.attemptId)).toMatchObject({
      kind: 'pending',
      state: 'not_sent',
      poolState: 'claimed',
    });
    expect(await expired.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' }); // real routine ACL absent
    expect(
      (
        await f.owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [
          a.prepared.requestId,
        ])
      ).rows[0]!.state,
    ).toBe('claimed');
  });
  it('only committed exact not_sent release intent mints ephemeral permission; routine ACL refusal retains hold, fixture-only right releases once', async () => {
    const a = await reserve('release');
    expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'pending' });
    expect(await a.b.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(await a.b.cancel(authority, a.attemptId)).toMatchObject({ kind: 'pending', state: 'not_sent' });
    const actual = makeCutroomPool(() => f.pool.connect());
    expect(
      await actual.release(
        a.approval,
        { operationId: randomUUID(), attemptId: a.attemptId, kind: 'release', state: 'pending', fence: 2 },
        {} as CutroomNotSent,
      ),
    ).toEqual({ kind: 'held', reason: 'identity' });
    expect(await a.b.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    const op = await f.world.db
      .selectFrom('reasoning.cutroom_pool_operations')
      .selectAll()
      .where('attempt_id', '=', a.attemptId)
      .where('kind', '=', 'release')
      .executeTakeFirstOrThrow();
    expect(op.fence).toBe(2);
    expect(op.state).toBe('held');
    await f.grantReleaseForFixtureOnly();
    await a.b.reconcile(authority, a.attemptId);
    expect(await a.b.releaseNotSent(authority, a.attemptId)).toMatchObject({
      kind: 'pending',
      state: 'not_sent',
      poolState: 'released',
    });
    expect(await a.b.reconcile(authority, a.attemptId)).toMatchObject({ kind: 'pending', poolState: 'released' });
    expect(
      (
        await f.owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [
          a.prepared.requestId,
        ])
      ).rows[0]!.state,
    ).toBe('released');
  });
  it('a changed attempt fence parks an already committed release intention and never frees money', async () => {
    const a = await reserve('stale-fence');
    await a.b.claim(authority, a.attemptId);
    await a.b.cancel(authority, a.attemptId);
    const real = f.ports().pool;
    const held = f.service({ pool: { ...real, release: () => Promise.resolve({ kind: 'held', reason: 'unknown' }) } });
    expect(await held.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    await f.world.db
      .updateTable('reasoning.cutroom_attempts')
      .set({ fence: 3, pool_state: 'claimed' })
      .where('id', '=', a.attemptId)
      .execute();
    expect(await a.b.releaseNotSent(authority, a.attemptId)).toEqual({ kind: 'held', code: 'pending' });
    expect(
      (
        await f.owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [
          a.prepared.requestId,
        ])
      ).rows[0]!.state,
    ).toBe('claimed');
  });
  it('a captured/serialized/stale release proof cannot be reused outside its acknowledged release call', async () => {
    const a = await reserve('stale-proof');
    await a.b.claim(authority, a.attemptId);
    await a.b.cancel(authority, a.attemptId);
    const real = f.ports().pool;
    let saved: { proof: CutroomNotSent; operation: CutroomPoolOperation } | undefined;
    const b = f.service({
      pool: {
        ...real,
        release: (_identity, operation, proof) => {
          saved = { proof, operation };
          return Promise.resolve({ kind: 'held', reason: 'unknown' });
        },
      },
    });
    expect(await b.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    if (!saved) throw new Error('CI proof not captured');
    expect(await real.release(a.approval, saved.operation, saved.proof)).toEqual({ kind: 'held', reason: 'identity' });
    expect(
      await real.release(a.approval, saved.operation, JSON.parse(JSON.stringify(saved.proof)) as CutroomNotSent),
    ).toEqual({ kind: 'held', reason: 'identity' });
    expect(
      (
        await f.owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [
          a.prepared.requestId,
        ])
      ).rows[0]!.state,
    ).toBe('claimed');
  });
  it('lost release world commit acknowledgement cannot mint a permit; lost pool release ACK recovers the same released order', async () => {
    const a = await reserve('release-ack');
    expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'pending' });
    await a.b.cancel(authority, a.attemptId);
    const base = f.ports().withScope;
    let fail = true,
      releaseCalls = 0;
    const real = f.ports().pool;
    const lost: WithCutroomScope = async (auth, mode, work) => {
      const r = await base(auth, mode, work);
      if (fail) {
        fail = false;
        throw new Error('CI release world ACK');
      }
      return r;
    };
    await expect(
      f
        .service({
          withScope: lost,
          pool: {
            ...real,
            release: async (...args) => {
              releaseCalls++;
              return real.release(...args);
            },
          },
        })
        .releaseNotSent(authority, a.attemptId),
    ).rejects.toThrow('CI release world ACK');
    expect(releaseCalls).toBe(0);
    const later = f.service({
      pool: {
        ...real,
        release: async (...args) => {
          await real.release(...args);
          throw new Error('CI release pool ACK');
        },
      },
    });
    expect(await later.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
    expect(await a.b.reconcile(authority, a.attemptId)).toMatchObject({ kind: 'pending', poolState: 'released' });
  });
  it.each(['dispatched', 'unknown'] as const)(
    'never releases or replaces a %s liability after payload purge',
    async (state) => {
      const a = await reserve(state);
      expect(await a.b.claim(authority, a.attemptId)).toMatchObject({ kind: 'pending' });
      await f.world.db
        .updateTable('reasoning.cutroom_attempts')
        .set({ state: 'dispatched', dispatch_intent_at: new Date() })
        .where('id', '=', a.attemptId)
        .execute();
      if (state === 'unknown')
        await f.world.db
          .updateTable('reasoning.cutroom_attempts')
          .set({ state: 'unknown' })
          .where('id', '=', a.attemptId)
          .execute();
      const future = () => new Date(Date.now() + 31 * 86400000),
        expired = f.service({ ledger: postgresCutroomLedger(makeEnqueueCutroom(f.boss), future), now: future });
      await expired.purge(authority);
      expect((await row(a.attemptId)).state).toBe(state);
      expect(await expired.cancel(authority, a.attemptId)).toMatchObject({ kind: 'held' });
      expect(await expired.releaseNotSent(authority, a.attemptId)).toMatchObject({ kind: 'held' });
      expect(
        (
          await f.owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [
            a.prepared.requestId,
          ])
        ).rows[0]!.state,
      ).toBe('claimed');
    },
  );
  it('actual grant cap and contradictory cost evidence hold all new admissions, without clamping bigint or releasing history', async () => {
    const g = await commissionFixture('cap-hold');
    try {
      const list = [];
      for (const tag of ['first', 'second', 'third']) {
        const c = g.command(tag, 75),
          b = g.actual(),
          r = await g.commission(b)(c.input);
        if (r.kind !== 'pending') throw new Error('CI cap reservation refused');
        const claim = await b.claim(authority, r.attemptId);
        list.push({ ...c, b, id: r.attemptId });
        expect(claim).toMatchObject({ kind: tag === 'third' ? 'held' : 'pending' });
      }
      expect(Number((await g.owner.query<{ n: string }>('select count(*) n from public.pool_order')).rows[0]!.n)).toBe(
        2,
      );
      await g.owner.query(
        `grant execute on function public.pool_v2_settle(text,public.pool_v2_identity,text,bigint,text,text,text) to "${g.role}"`,
      );
      const first = list[0]!,
        i = first.approval,
        client = await g.pool.connect();
      try {
        const args = [
          i.grantRef,
          i.requestId,
          i.scriptSha256,
          i.take,
          i.until,
          i.requestSha256,
          i.worldId,
          i.ceilingCents,
          i.approvalRef,
        ];
        const command =
          'select * from public.pool_v2_settle($1,row($2,$3,$4,$5,$6,$7,$8,$9)::public.pool_v2_identity,$10,$11::bigint,$12,$13,$14)';
        await client.query(command, [...args, 'completed', '60', 'fictional-run', 'a'.repeat(64), 'fixture:first']);
        expect(
          (
            await client.query<{ status: string }>(command, [
              ...args,
              'completed',
              '80',
              'fictional-run',
              'b'.repeat(64),
              'fixture:contradiction',
            ])
          ).rows[0]!.status,
        ).toBe('held_needs_operator');
        const status = (
          await client.query<{ accounting_hold: boolean; grant_base_cents: string; grant_effective_cents: string }>(
            'select * from public.pool_v2_grant_status($1)',
            [i.grantRef],
          )
        ).rows[0]!;
        expect(status).toMatchObject({ accounting_hold: true, grant_base_cents: '135', grant_effective_cents: '155' });
        expect(
          (
            await client.query<{ status: string }>(command, [
              ...args,
              'completed',
              '9007199254740991',
              'fictional-run',
              'c'.repeat(64),
              'fixture:bigint',
            ])
          ).rows[0]!.status,
        ).toBe('held_needs_operator');
        expect(
          (
            await client.query<{ grant_base_cents: string; grant_effective_cents: string }>(
              'select * from public.pool_v2_grant_status($1)',
              [i.grantRef],
            )
          ).rows[0],
        ).toMatchObject({ grant_base_cents: '135', grant_effective_cents: '9007199254741066' });
      } finally {
        client.release();
      }
      expect(await first.b.reconcile(authority, first.id)).toMatchObject({ kind: 'held' });
      const c = g.command('held'),
        b = g.actual(),
        r = await g.commission(b)(c.input);
      if (r.kind !== 'pending') throw new Error('CI held candidate missing');
      expect(await b.claim(authority, r.attemptId)).toMatchObject({ kind: 'held' });
      expect(Number((await g.owner.query<{ n: string }>('select count(*) n from public.pool_order')).rows[0]!.n)).toBe(
        2,
      );
    } finally {
      await g.close();
    }
  });
  it('retired pool authority parks the same admitted candidate and preserves the actual immutable binding', async () => {
    const g = await commissionFixture('retired');
    try {
      const c = g.command('one'),
        b = g.actual(),
        r = await g.commission(b)(c.input);
      if (r.kind !== 'pending') throw new Error('CI retired candidate missing');
      expect(await b.claim(authority, r.attemptId)).toMatchObject({ kind: 'pending' });
      const before = await g.world.db
        .selectFrom('reasoning.cutroom_attempts')
        .selectAll()
        .where('id', '=', r.attemptId)
        .executeTakeFirstOrThrow();
      await g.owner.query('select public.pool_v2_admin_gate(false,true)');
      expect(await b.reconcile(authority, r.attemptId)).toMatchObject({ kind: 'held' });
      expect(
        (
          await g.world.db
            .selectFrom('reasoning.cutroom_attempts')
            .selectAll()
            .where('id', '=', r.attemptId)
            .executeTakeFirstOrThrow()
        ).binding_id,
      ).toBe(before.binding_id);
      const next = g.command('two'),
        later = g.actual(),
        reserved = await g.commission(later)(next.input);
      if (reserved.kind !== 'pending') throw new Error('CI retired pending candidate missing');
      expect(await later.claim(authority, reserved.attemptId)).toMatchObject({ kind: 'held' });
      expect(Number((await g.owner.query<{ n: string }>('select count(*) n from public.pool_order')).rows[0]!.n)).toBe(
        1,
      );
    } finally {
      await g.close();
    }
  });
  it('pool connection/read/release are refused inside a marked world transaction; no hidden executor or HTTP authority', async () => {
    const a = await reserve('network'),
      adapter = makeCutroomPool(() => f.pool.connect());
    await withTransaction(f.world.db, 'ci.no-pool-network', async () => {
      await expect(adapter.read(a.approval)).rejects.toMatchObject({ code: 'NETWORK_IN_TRANSACTION' });
      await expect(adapter.claim(a.approval)).rejects.toMatchObject({ code: 'NETWORK_IN_TRANSACTION' });
      await expect(
        adapter.release(
          a.approval,
          { operationId: randomUUID(), attemptId: a.attemptId, kind: 'release', fence: 1, state: 'pending' },
          {} as CutroomNotSent,
        ),
      ).rejects.toMatchObject({ code: 'NETWORK_IN_TRANSACTION' });
    });
  });
});
