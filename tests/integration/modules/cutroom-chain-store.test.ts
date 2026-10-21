import { randomUUID } from 'node:crypto';
import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  makeCommissionChainSnapshots,
  postgresCommissionChainStore,
  makeCutroomChainSnapshotCollector,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  CUTROOM_CHAIN_UPSTREAM_REVISION,
  type CutroomCollectedChain,
  type CommissionChainStore,
  type CommissionChainStorePorts,
} from '@knowscroll/backend/modules/content';
import { makeWithCutroomAccountingScope } from '@knowscroll/backend/reasoning/nest-providers';
import { cutroomAccountingTransactionOf as scopeTransaction } from '../../../packages/backend/src/infrastructure/postgres/cutroom-scope.js';
import type { CutroomAccountingScopeTx } from '@knowscroll/backend/reasoning';
import {
  fixtureDispatchedCommission,
  commissionFixture,
  hash,
  type CommissionFixture,
} from '../support/commission-fixture.js';
import { gate } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
// All scripts, responses, pool LOGINs and human/profile/funds records are disposable authored CI fixtures.
describe('durable sanitized chain evidence and atomic C1 pending handoff (real PG/pg-boss, no provider)', () => {
  let f: CommissionFixture;
  beforeAll(async () => {
    f = await commissionFixture('chainstore');
  });
  afterAll(async () => {
    await f.close();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const db = () => f.world.db;
  const store = () => postgresCommissionChainStore();
  const fixture = (tag: string) => fixtureDispatchedCommission(f, tag);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const service = (c: Fixture, overrides: Partial<CommissionChainStorePorts> = {}) =>
    makeCommissionChainSnapshots({
      enabled: true,
      execution: c.execution,
      withAccountingScope: c.accounting,
      store: store(),
      ...overrides,
    });
  function envelope(c: Fixture, two = true): CutroomCollectedChain {
    const run = (runId: string, child: boolean) => {
      const status = {
        contractVersion: 1,
        requestId: c.expected.requestId,
        runId,
        state: 'finished',
        lastSeq: 8,
        ...(two ? (child ? { resumes: 'fixture-original' } : { resumedBy: 'fixture-child' }) : {}),
      };
      const record = { contractVersion: 1, runId, pictures: [], takes: [], degradations: [] };
      return {
        statusUtf8: JSON.stringify(status),
        resultUtf8: JSON.stringify({
          contractVersion: 1,
          runId,
          requestId: c.expected.requestId,
          status: 'failed',
          costCents: child ? 20 : 34,
        }),
        recordUtf8: JSON.stringify(record),
        closingStatusUtf8: JSON.stringify(status),
        openedAtMs: 1000,
        resultAtMs: 1001,
        recordAtMs: 1002,
        closedAtMs: 1003,
      };
    };
    return {
      version: 'cutroom-chain-collection.v1',
      evidenceSha256: hash('fictional-raw-aggregate'),
      calls: two ? 9 : 5,
      responseBytes: 2000,
      observedAtMs: 1004,
      profile: {
        upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
        soleWriterEvidenceSha256: hash('fixture-sole-writer'),
        observedAtMs: 1000,
        expiresAtMs: 31000,
      },
      input: {
        upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
        validationTimeMs: 1004,
        expected: c.expected,
        runs: two ? [run('fixture-original', false), run('fixture-child', true)] : [run('fixture-original', false)],
      },
    };
  }
  async function counts(c: Fixture) {
    return (
      await sql<{ s: string; d: string; o: string; i: string; j: string }>`select
      (select count(*) from content.cutroom_chain_snapshots where attempt_id=${c.target.attemptId}::uuid) s,
      (select count(*) from content.cutroom_chain_documents where snapshot_id in
        (select id from content.cutroom_chain_snapshots where attempt_id=${c.target.attemptId}::uuid)) d,
      (select count(*) from reasoning.cutroom_observations where attempt_id=${c.target.attemptId}::uuid) o,
      (select count(*) from reasoning.cutroom_accounting_intents where attempt_id=${c.target.attemptId}::uuid) i,
      (select count(*) from pgboss.job where name='reasoning.cutroom-accounting'
        and data->>'attemptId'=${c.target.attemptId}) j`.execute(db())
    ).rows[0]!;
  }
  async function saved(c: Fixture, value = envelope(c)) {
    const result = await service(c).recordCollectedChain(c.target, value);
    expect(result.kind).toBe('recorded');
    if (result.kind !== 'recorded') throw new Error('CI_SAVE');
    return result;
  }
  it('stores exact original/child documents with one pending handoff; replay and observation lookup recover sealed historical evidence', async () => {
    const c = await fixture('eight'),
      value = envelope(c);
    const poolBefore = (await f.owner.query('select * from public.pool_order')).rows;
    const result = await saved(c, value);
    expect(await counts(c)).toEqual({ s: '1', d: '8', o: '1', i: '1', j: '1' });
    expect(await service(c).recordCollectedChain(c.target, value)).toEqual({ ...result, kind: 'replayed' });
    const read = await service(c).readSnapshot(c.target, { observationId: result.observationId });
    expect(read).toMatchObject({
      kind: 'snapshot',
      snapshotId: result.snapshotId,
      header: {
        collection: { observedAtMs: 1004 },
        summary: { actualCents: 54, overCeiling: true, videoKind: 'unavailable' },
      },
      report: { kind: 'complete', cost: { actualCents: 54, overCeiling: true } },
    });
    if (read.kind !== 'snapshot') throw new Error('CI_READ');
    expect(read.documents.map((d) => d.bodyUtf8)).toEqual(
      value.input.runs.flatMap((r) => [r.statusUtf8, r.resultUtf8, r.recordUtf8, r.closingStatusUtf8]),
    );
    expect(read.header.collection.evidenceSha256).toBe(value.evidenceSha256);
    expect(read.header.execution.poolReceipt).toEqual(c.preflight.poolReceipt);
    const observation = await db()
      .selectFrom('reasoning.cutroom_observations')
      .selectAll()
      .where('id', '=', result.observationId)
      .executeTakeFirstOrThrow();
    expect(observation.evidence_sha256).toBe(result.snapshotSha256);
    expect(observation.evidence_sha256).not.toBe(value.evidenceSha256);
    expect((await f.owner.query('select * from public.pool_order')).rows).toEqual(poolBefore);
    expect(
      await db()
        .selectFrom('reasoning.cutroom_attempts')
        .select(['state', 'pool_state'])
        .where('id', '=', c.target.attemptId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'dispatched', pool_state: 'claimed' });
  });
  it('actual collector sanitizes private URL/reason bytes before the durable handoff and preserves labels', async () => {
    const c = await fixture('collector'),
      canary = 'https://credential.invalid/private?key=DO-NOT-STORE';
    const status = {
      contractVersion: 1,
      runId: 'fixture-video',
      requestId: c.expected.requestId,
      state: 'finished',
      lastSeq: 3,
    };
    const record = {
      contractVersion: 1,
      runId: status.runId,
      pictures: [
        {
          pictureId: 'picture1',
          shotId: 'shot-0',
          chosen: true,
          checks: ['technical', 'text', 'witness', 'reconcile'].map((step) => ({
            gate: '1',
            step,
            outcome: step === 'witness' ? 'accept_with_label' : 'accept',
          })),
        },
      ],
      takes: [
        {
          takeId: 'take1',
          shotId: 'shot-0',
          number: 1,
          used: true,
          checks: ['2', '3', '4', '5'].map((gate) => ({ gate, outcome: 'accept' })),
        },
      ],
      degradations: [{ shotId: 'shot-0', reason: canary }],
    };
    const result = {
      contractVersion: 1,
      runId: status.runId,
      requestId: c.expected.requestId,
      status: 'completed',
      until: 'video',
      costCents: 34,
      estimateCents: 50,
      stills: [{ pictureId: 'picture1', shotId: 'shot-0', path: canary }],
      video: { path: canary },
      degradations: record.degradations,
    };
    const replies = [{ contractVersion: 1, ready: true }, status, result, record, status];
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(replies.shift()), { headers: { 'content-type': 'application/json' } }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const collected = await makeCutroomChainSnapshotCollector({
      enabled: true,
      origin: 'http://127.0.0.1:9876',
      now: () => 1000,
      profile: envelope(c).profile,
    }).collect(c.expected);
    expect(collected.kind).toBe('collected');
    if (collected.kind !== 'collected') throw new Error('CI_COLLECT');
    const s = await saved(c, collected.snapshot);
    const read = await service(c).readSnapshot(c.target, {
      snapshotId: s.snapshotId,
      snapshotSha256: s.snapshotSha256,
    });
    expect(read).toMatchObject({ kind: 'snapshot', report: { video: { kind: 'candidate', labels: [{ gate: '1' }] } } });
    expect(JSON.stringify(read)).not.toContain(canary);
    expect(JSON.stringify(read)).not.toContain('DO-NOT-STORE');
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('same-attempt concurrent duplicate commits one snapshot/observation/intent/job and identical IDs', async () => {
    const c = await fixture('concurrent'),
      value = envelope(c);
    const results = await Promise.all([
      service(c).recordCollectedChain(c.target, value),
      service(c).recordCollectedChain(c.target, value),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['recorded', 'replayed']);
    expect(results[0]).toMatchObject({ snapshotId: 'snapshotId' in results[1] ? results[1].snapshotId : '' });
    expect(await counts(c)).toEqual({ s: '1', d: '8', o: '1', i: '1', j: '1' });
  });
  it('32 immutable observations fill the cap; a contradictory later capture never replaces history and33rd cannot enqueue', async () => {
    const c = await fixture('cap');
    const ids: string[] = [];
    for (let n = 0; n < 32; n++) {
      const v = envelope(c, false);
      v.observedAtMs += n;
      v.input.validationTimeMs += n;
      v.evidenceSha256 = hash(`capture-${n}`);
      const r = await saved(c, v);
      ids.push(r.snapshotId);
    }
    const before = await counts(c),
      extra = envelope(c, false);
    extra.evidenceSha256 = hash('contradictory-33');
    expect(await service(c).recordCollectedChain(c.target, extra)).toEqual({ kind: 'refused', code: 'capacity' });
    expect(await counts(c)).toEqual(before);
    expect(new Set(ids).size).toBe(32);
    const first = envelope(c, false);
    first.evidenceSha256 = hash('capture-0');
    expect(await service(c).recordCollectedChain(c.target, first)).toMatchObject({
      kind: 'replayed',
      snapshotId: ids[0],
    });
  });
  it('full2MiB/four-per-run boundary is retained exactly; one extra UTF8 byte refuses before effects', async () => {
    const c = await fixture('bounds'),
      v = envelope(c);
    for (const r of v.input.runs)
      for (const key of ['statusUtf8', 'resultUtf8', 'recordUtf8', 'closingStatusUtf8'] as const)
        r[key] += ' '.repeat(262144 - Buffer.byteLength(r[key], 'utf8'));
    v.responseBytes = 2097152;
    const r = await saved(c, v);
    expect(
      await db()
        .selectFrom('content.cutroom_chain_snapshots')
        .select('total_document_bytes')
        .where('id', '=', r.snapshotId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ total_document_bytes: 2097152 });
    const before = await counts(c);
    v.input.runs[0]!.recordUtf8 += 'x';
    expect(await service(c).recordCollectedChain(c.target, v)).toEqual({ kind: 'refused', code: 'invalid' });
    expect(await counts(c)).toEqual(before);
  });
  for (const variant of ['expected', 'profile', 'version', 'raw', 'missingExecution'] as const)
    it(`refuses ${variant} without observations`, async () => {
      const c = await fixture(`wrong-${variant}`),
        v = envelope(c),
        before = await counts(c);
      let input: unknown = v;
      if (variant === 'expected') v.input.expected.requestSha256 = hash('foreign');
      if (variant === 'profile') v.profile.soleWriterEvidenceSha256 = hash('foreign');
      if (variant === 'version') input = { ...v, version: 'unknown' };
      if (variant === 'raw') input = { ...v, rawBody: 'PRIVATE_CANARY' };
      const s = service(
        c,
        variant === 'missingExecution'
          ? { execution: { ...c.execution, readAccountingBinding: () => Promise.resolve(undefined) } }
          : {},
      );
      expect(await s.recordCollectedChain(c.target, input)).toMatchObject({ kind: 'refused' });
      expect(await counts(c)).toEqual(before);
    });
  it('disabled defaults do no work; forged/closed capability cannot reach the real adapter', async () => {
    const c = await fixture('scope'),
      before = await counts(c);
    const p = { execution: c.execution, withAccountingScope: c.accounting, store: store() };
    expect(await makeCommissionChainSnapshots(p).recordCollectedChain(c.target, envelope(c))).toEqual({
      kind: 'refused',
      code: 'disabled',
    });
    let closed: CutroomAccountingScopeTx | undefined;
    await c.accounting(c.target, (s) => {
      closed = s;
      return Promise.resolve();
    });
    await expect(store().inspect(closed!, {} as never)).rejects.toThrow('forged or closed');
    await expect(store().inspect({ ...closed! }, {} as never)).rejects.toThrow('forged or closed');
    expect(await counts(c)).toEqual(before);
  });
  it('old-generation disabled-root and purged bytes remain accounting-only; lost ACK recovers exact IDs without a second handoff', async () => {
    const c = await fixture('historical'),
      v = envelope(c);
    await db()
      .updateTable('reasoning.cutroom_requests')
      .set({ request_utf8: null })
      .where('attempt_id', '=', c.target.attemptId)
      .execute();
    await db()
      .updateTable('reasoning.cutroom_scopes')
      .set({ enabled: false, generation: 2 })
      .where('world_id', '=', 'dev')
      .execute();
    try {
      const s = service(c, {
        withAccountingScope: async (target, work) => {
          const value = await c.accounting(target, work);
          if (value.kind === 'entered') throw new Error('CI_COMMIT_ACK_LOST');
          return value;
        },
      });
      expect(await s.recordCollectedChain(c.target, v)).toEqual({ kind: 'refused', code: 'unavailable' });
      const replay = await service(c).recordCollectedChain(c.target, v);
      expect(replay.kind).toBe('replayed');
      expect(await counts(c)).toEqual({ s: '1', d: '8', o: '1', i: '1', j: '1' });
    } finally {
      await db()
        .updateTable('reasoning.cutroom_scopes')
        .set({ enabled: true, generation: 1 })
        .where('world_id', '=', 'dev')
        .execute();
    }
  });
  it('root wait rechecks current generation and actual marker forbids network in the accounting transaction', async () => {
    const c = await fixture('rootwait'),
      locked = gate<number>(),
      release = gate();
    const holding = c.accounting(c.target, async (scope) => {
      const trx = scopeTransaction(scope);
      await sql`update reasoning.cutroom_scopes set enabled=false,generation=2 where world_id='dev'`.execute(trx);
      locked.open((await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid);
      await release.promise;
    });
    const pid = await locked.promise,
      recording = service(c).recordCollectedChain(c.target, envelope(c));
    try {
      await vi.waitFor(
        async () => {
          const blocked = (
            await sql<{ blocked: boolean }>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) blocked`.execute(db())
          ).rows[0]!.blocked;
          expect(blocked).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      release.open();
      await holding;
    }
    try {
      expect((await recording).kind).toBe('recorded');
      expect(
        await db()
          .selectFrom('reasoning.cutroom_observations')
          .select('observed_generation')
          .where('attempt_id', '=', c.target.attemptId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ observed_generation: 2 });
    } finally {
      await db()
        .updateTable('reasoning.cutroom_scopes')
        .set({ enabled: true, generation: 1 })
        .where('world_id', '=', 'dev')
        .execute();
    }
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const read = await c.accounting(c.target, () =>
      makeCutroomChainSnapshotCollector({
        enabled: true,
        origin: 'http://127.0.0.1:9876',
        now: () => 1000,
        profile: envelope(c).profile,
      }).collect(c.expected),
    );
    expect(read).toMatchObject({ kind: 'entered', value: { kind: 'unknown' } });
    expect(fetch).not.toHaveBeenCalled();
  });
  const faults = [
    { table: 'reasoning.cutroom_observations', condition: 'true', label: 'observation' },
    { table: 'reasoning.cutroom_accounting_intents', condition: 'true', label: 'pending-intent' },
    { table: 'pgboss.job', condition: "new.name='reasoning.cutroom-accounting'", label: 'job' },
    { table: 'content.cutroom_chain_snapshots', condition: 'true', label: 'header' },
    ...[0, 1].flatMap((ordinal) =>
      ['opening', 'result', 'record', 'closing'].map((kind) => ({
        table: 'content.cutroom_chain_documents',
        condition: `new.run_ordinal=${ordinal} and new.kind='${kind}'`,
        label: `document-${ordinal}-${kind}`,
      })),
    ),
  ];
  for (const fault of faults)
    it(`real SQL failure at ${fault.label} rolls snapshot, observation, pending intent and job back together`, async () => {
      const c = await fixture(`fault-${fault.label}`),
        before = await counts(c);
      // Closed authored table/condition catalogue only; no input/provider text becomes SQL.
      await sql
        .raw(
          `create function content.ci_fail_chain() returns trigger language plpgsql as $$
      begin if ${fault.condition} then raise check_violation using message='CI_CHAIN_WRITE_FAILURE'; end if; return new; end $$`,
        )
        .execute(db());
      await sql
        .raw(
          `create trigger ci_chain_fault before insert on ${fault.table} for each row execute function content.ci_fail_chain()`,
        )
        .execute(db());
      try {
        expect(await service(c).recordCollectedChain(c.target, envelope(c))).toEqual({
          kind: 'refused',
          code: 'unavailable',
        });
        expect(await counts(c)).toEqual(before);
      } finally {
        await sql.raw(`drop trigger ci_chain_fault on ${fault.table}`).execute(db());
        await sql`drop function content.ci_fail_chain()`.execute(db());
      }
    });
  it('deferred SQL completeness rejects direct incomplete sets and rolls their pending accounting work back', async () => {
    const c = await fixture('deferred'),
      result = await saved(c),
      before = await counts(c);
    const row = await db()
      .selectFrom('content.cutroom_chain_snapshots')
      .selectAll()
      .where('id', '=', result.snapshotId)
      .executeTakeFirstOrThrow();
    await expect(
      c.accounting(c.target, async (scope) => {
        const observation = await c.execution.recordObservationInScope(scope, {
          requestId: c.expected.requestId,
          runId: null,
          evidenceSha256: hash('direct-incomplete'),
          outcome: 'terminal_unvalidated',
        });
        if (observation.kind !== 'pending') throw new Error('CI_OBSERVATION');
        const header = row.header_utf8 + ' ';
        // Valid new initial row/hash, but no documents. The error is from deferred completeness at COMMIT.
        await sql`insert into content.cutroom_chain_snapshots
        (id,world_id,business_run_id,attempt_id,observation_id,snapshot_ordinal,projection_version,header_utf8,
        snapshot_sha256,document_count,total_document_bytes,sealed_validation_time_ms,engine_actual_cents,over_ceiling,video_kind)
        values(${randomUUID()}::uuid,'dev',${c.target.businessRunId}::uuid,${c.target.attemptId}::uuid,
        ${observation.observationId}::uuid,2,${row.projection_version},${header},${hash(header)},${row.document_count},
        ${row.total_document_bytes},${row.sealed_validation_time_ms}::bigint,${row.engine_actual_cents}::bigint,
        ${row.over_ceiling},${row.video_kind})`.execute(scopeTransaction(scope));
      }),
    ).rejects.toMatchObject({ code: '23514', message: 'cutroom_chain_incomplete' });
    expect(await counts(c)).toEqual(before);
  });
  it('SQL SHA/byte checks and immutability reject bypass; stored-row corruption is refused without a second observation', async () => {
    const c = await fixture('sql-bounds'),
      r = await saved(c),
      before = await counts(c);
    await expect(
      db()
        .updateTable('content.cutroom_chain_snapshots')
        .set({ over_ceiling: false })
        .where('id', '=', r.snapshotId)
        .execute(),
    ).rejects.toThrow('cutroom_chain_immutable');
    await expect(
      db().deleteFrom('content.cutroom_chain_documents').where('snapshot_id', '=', r.snapshotId).execute(),
    ).rejects.toThrow('cutroom_chain_immutable');
    const originalStore = store();
    const corrupt: CommissionChainStore = {
      ...originalStore,
      async read(scope, selector) {
        const s = await originalStore.read(scope, selector);
        return s && { ...s, actualCents: '0' };
      },
    };
    expect(await service(c, { store: corrupt }).readSnapshot(c.target, { observationId: r.observationId })).toEqual({
      kind: 'refused',
      code: 'corrupt',
    });
    const badDocs: CommissionChainStore = {
      ...originalStore,
      async read(scope, selector) {
        const s = await originalStore.read(scope, selector);
        return (
          s && { ...s, documents: s.documents.map((d, index) => (index === 0 ? { ...d, sha256: hash('foreign') } : d)) }
        );
      },
    };
    expect(await service(c, { store: badDocs }).readSnapshot(c.target, { observationId: r.observationId })).toEqual({
      kind: 'refused',
      code: 'corrupt',
    });
    expect(await counts(c)).toEqual(before);
  });
  it('owned SQL metadata preserves microseconds and refuses a same-millisecond receipt disagreement', async () => {
    const c = await fixture('micros'),
      before = await counts(c);
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        return args.node;
      },
      transformResult(args) {
        return Promise.resolve({
          ...args.result,
          rows: args.result.rows.map((row) => {
            const claimed = row['claimed'];
            if (typeof claimed !== 'string' || typeof row['retained_claimed'] !== 'string') return row;
            const digit = Number(claimed.slice(-2, -1));
            const changed = claimed.slice(0, -2) + String((digit + 1) % 10) + 'Z';
            expect(Date.parse(changed)).toBe(Date.parse(claimed));
            expect(changed).not.toBe(claimed);
            return { ...row, claimed: changed };
          }),
        });
      },
    };
    const scope = makeWithCutroomAccountingScope(db().withPlugin(plugin), { enabled: true, lockTimeoutMs: 5000 });
    expect(await service(c, { withAccountingScope: scope }).recordCollectedChain(c.target, envelope(c))).toEqual({
      kind: 'refused',
      code: 'identity',
    });
    expect(await counts(c)).toEqual(before);
  });
  it('shared snapshots/all versions/jobs survive erasure of an unrelated disposable personal universe', async () => {
    const c = await fixture('personal'),
      v = envelope(c);
    await saved(c, v);
    v.evidenceSha256 = hash('later-evidence');
    await saved(c, v);
    const before = await counts(c),
      person = await seedPerson(db());
    const erased = await makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })(person.authority, (scope) =>
      eraseUniverse(scope, personalStores),
    );
    expect(erased.kind).toBe('entered');
    expect(await counts(c)).toEqual(before);
  });
  it('actual SQL row hash/byte constraints reject wrong documents, and a DDL-valid corrupt header column fails readback closed', async () => {
    const c = await fixture('direct-corruption'),
      r = await saved(c);
    const row = await db()
      .selectFrom('content.cutroom_chain_snapshots')
      .selectAll()
      .where('id', '=', r.snapshotId)
      .executeTakeFirstOrThrow();
    const docs = await db()
      .selectFrom('content.cutroom_chain_documents')
      .selectAll()
      .where('snapshot_id', '=', r.snapshotId)
      .execute();
    async function initial(scope: CutroomAccountingScopeTx, tag: string, cost = row.engine_actual_cents) {
      const header = row.header_utf8.replace(hash('fictional-raw-aggregate'), hash(tag)),
        sha = hash(header),
        id = randomUUID();
      const observation = await c.execution.recordObservationInScope(scope, {
        requestId: c.expected.requestId,
        runId: 'fixture-original',
        evidenceSha256: sha,
        outcome: 'terminal_unvalidated',
      });
      if (observation.kind !== 'pending') throw new Error('CI_OBSERVATION');
      await scopeTransaction(scope)
        .insertInto('content.cutroom_chain_snapshots')
        .values({
          ...row,
          id,
          observation_id: observation.observationId,
          snapshot_ordinal: 2,
          header_utf8: header,
          snapshot_sha256: sha,
          engine_actual_cents: cost,
        })
        .execute();
      return { id, observationId: observation.observationId, sha };
    }
    const before = await counts(c);
    for (const bad of ['hash', 'bytes'] as const) {
      await expect(
        c.accounting(c.target, async (scope) => {
          const target = await initial(scope, `bad-${bad}`),
            d = docs[0]!;
          await scopeTransaction(scope)
            .insertInto('content.cutroom_chain_documents')
            .values({
              ...d,
              snapshot_id: target.id,
              sha256: bad === 'hash' ? hash('wrong') : d.sha256,
              byte_length: bad === 'bytes' ? d.byte_length + 1 : d.byte_length,
            })
            .execute();
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await counts(c)).toEqual(before);
    }
    const corrupt = await c.accounting(c.target, async (scope) => {
      const target = await initial(scope, 'corrupt-cost', '0');
      for (const d of docs)
        await scopeTransaction(scope)
          .insertInto('content.cutroom_chain_documents')
          .values({ ...d, snapshot_id: target.id })
          .execute();
      return target;
    });
    if (corrupt.kind !== 'entered') throw new Error('CI_CORRUPT_ROW');
    const after = await counts(c);
    expect(await service(c).readSnapshot(c.target, { observationId: corrupt.value.observationId })).toEqual({
      kind: 'refused',
      code: 'corrupt',
    });
    expect(await counts(c)).toEqual(after);
  });
});
