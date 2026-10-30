import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import {
  makeWithPersonalScope,
  transactionOf,
  withTransaction,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { guardedModelPort, makeAttemptLedger, type AttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import {
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  gate,
  signal,
  systemAuthority,
} from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

/** CI FIXTURES ONLY. Real PostgreSQL locks/receipts, no provider/owner database or network. */
describe('personal Reasoning payload erasure cannot rewrite financial truth or resurrect a late answer', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('reasoning_privacy');
  });
  afterEach(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const scope = () => makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 });
  const ledger = () => makeAttemptLedger(db());
  const reasoning = personalStores.find((store) => store.module === 'reasoning')!;
  const erase = (person: FixturePerson) => scope()(person.authority, (tx) => eraseUniverse(tx, [reasoning]));
  const propose = (harness: ReturnType<typeof fixtureHarness>['harness'], person: FixturePerson, id = randomUUID()) =>
    harness.propose(
      { run: fixtureRun(systemAuthority(person.universeId), id), role: echoRole, context: fixtureContext },
      signal(),
    );
  const receipt = (id: string) =>
    db().selectFrom('reasoning.usage_receipts').selectAll().where('attempt_id', '=', id).executeTakeFirstOrThrow();
  const rows = (person: FixturePerson) =>
    db()
      .selectFrom('reasoning.external_attempts')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .orderBy('id')
      .execute();
  const redacted = async (person: FixturePerson) => {
    const [attempt] = await rows(person);
    const run = await db()
      .selectFrom('reasoning.business_runs')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({ purpose: 'privacy-erased', context_bundle_ref: null, context_refs: null });
    expect(run.privacy_erased_at).toBeInstanceOf(Date);
    expect(attempt).toMatchObject({ output: null, output_issues: null, quota_observation: null, dispatched_by: null });
    expect(attempt?.privacy_erased_at).toBeInstanceOf(Date);
    expect(JSON.stringify([run, attempt])).not.toContain('private-fixture-canary');
    expect(
      await db()
        .selectFrom('reasoning.protected_requests')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([]);
    return attempt!;
  };
  async function seeded(person: FixturePerson, state: 'reserved' | 'dispatched' | 'unknown' = 'dispatched') {
    const id = randomUUID(),
      runId = randomUUID();
    const body = new TextEncoder().encode('{"fixture":"private-fixture-canary"}');
    await scope()(person.authority, async (tx) => {
      await ledger().admitRun(tx, {
        id: runId,
        ownerModule: 'fixture',
        purpose: 'private-fixture-canary',
        roleId: 'fixture.privacy',
        roleVersion: 'v1',
        policyVersion: 'fixture.v1',
        provider: 'fixture',
        model: 'fixture',
        contextBundleRef: 'private-fixture-canary',
        contextRefs: ['private-fixture-canary'],
      });
      await ledger().reserve(tx, {
        id,
        runId,
        step: 'primary',
        provider: 'fixture',
        model: 'fixture',
        roleId: 'fixture.privacy',
        roleVersion: 'v1',
        promptVersion: 'fixture.v1',
        requestHash: createHash('sha256').update(body).digest('hex'),
        requestBody: body,
        reservedTokens: 150,
        maxOutputTokens: 100,
        requestRetentionSeconds: 3600,
      });
      if (state !== 'reserved')
        expect(
          await ledger().commitDispatch(tx, id, {
            dispatchId: randomUUID(),
            dispatchedBy: 'private-fixture-canary',
            quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
          }),
        ).toBe(true);
    });
    if (state === 'unknown')
      expect(
        await ledger().settle({ scopeId: person.universeId, attemptId: id }, 'dispatched', 'unknown', {
          outcomeCode: 'TRANSPORT_OUTCOME_UNKNOWN',
        }),
      ).toBe(true);
    return { id, runId, ref: { scopeId: person.universeId, attemptId: id } };
  }

  for (const [label, scenario, state, receiptState] of [
    [
      'valid reply',
      { kind: 'success', text: '{"ok":true,"echo":"private-fixture-canary"}', remoteId: 'fixture-message-1' },
      'succeeded',
      'settled',
    ],
    ['invalid reply', { kind: 'malformed', text: 'private-fixture-canary' }, 'succeeded', 'settled'],
    ['conclusive rejection without usage', { kind: 'rate_limited' }, 'failed', 'released'],
    [
      'conclusive rejection with usage',
      { kind: 'rate_limited', usage: { inputTokens: 9, outputTokens: 2, cachedTokens: 1 } },
      'failed',
      'settled',
    ],
    ['possibly sent timeout', { kind: 'timeout_after_dispatch' }, 'unknown', 'unknown'],
  ] as const) {
    it(`redacts before a late ${label}, retains its original receipt classification, and never repairs/resends`, async () => {
      const person = await seedPerson(db());
      const entered = gate(),
        release = gate<FixtureScenario>();
      const model = fixtureModel(() => {
        entered.open();
        return { kind: 'hold', until: release.promise };
      });
      const { harness, ports } = fixtureHarness(db(), { model });
      const runId = randomUUID(),
        running = propose(harness, person, runId);
      await entered.promise;
      const before = (await rows(person))[0]!;
      expect((await erase(person)).kind).toBe('entered');
      const first = await redacted(person);
      expect(first.state).toBe('dispatched');
      expect(
        await ports.ledger.readProtectedRequest({ scopeId: person.universeId, attemptId: first.id }),
      ).toBeUndefined();
      release.open(scenario);
      expect(await running).toMatchObject({ kind: 'refused', reason: 'output_ineligible' });
      const after = await redacted(person);
      expect(after).toMatchObject({
        id: before.id,
        state,
        request_hash: before.request_hash,
        reserved_tokens: before.reserved_tokens,
      });
      expect(after.privacy_erased_at).toEqual(first.privacy_erased_at);
      expect(await receipt(after.id)).toMatchObject({ state: receiptState, conclusive_failure: state === 'failed' });
      expect((await propose(harness, person, runId)).kind).toBe('refused');
      expect(model.calls).toHaveLength(1);
    });
  }

  it('preserves an already-settled receipt while terminal cleanup deletes personal rows and leaves another universe untouched', async () => {
    const erased = await seedPerson(db()),
      kept = await seedPerson(db());
    const model = fixtureModel();
    const { harness } = fixtureHarness(db(), { model });
    expect((await propose(harness, erased)).kind).toBe('proposed');
    expect((await propose(harness, kept)).kind).toBe('proposed');
    const keptRows = await rows(kept),
      [before] = await rows(erased);
    const charged = await receipt(before!.id);
    expect(await erase(erased)).toMatchObject({
      kind: 'entered',
      value: [expect.objectContaining({ status: 'completed' })],
    });
    expect(await rows(erased)).toEqual([]);
    expect(
      await db()
        .selectFrom('reasoning.business_runs')
        .selectAll()
        .where('universe_id', '=', erased.universeId)
        .execute(),
    ).toEqual([]);
    expect(await rows(kept)).toEqual(keptRows);
    expect(await receipt(before!.id)).toEqual(charged);
  });

  it('re-reads committed state instead of returning a private in-memory reply after terminal erasure', async () => {
    const person = await seedPerson(db());
    const model = fixtureModel(() => ({ kind: 'success', text: '{"ok":true,"echo":"private-fixture-canary"}' }));
    const base = fixtureHarness(db(), { model }),
      committed = gate(),
      resume = gate();
    const override: AttemptLedger = {
      ...base.ports.ledger,
      async settle(ref, from, to, details) {
        const won = await base.ports.ledger.settle(ref, from, to, details);
        if (won && from === 'dispatched') {
          committed.open();
          await resume.promise;
        }
        return won;
      },
    };
    const { harness } = fixtureHarness(db(), { model, overrides: { ledger: override } });
    const running = propose(harness, person);
    await committed.promise;
    await erase(person);
    expect(await rows(person)).toEqual([]);
    resume.open();
    expect(await running).toMatchObject({ kind: 'refused', reason: 'output_ineligible' });
    expect(model.calls).toHaveLength(1);
  });

  it('releases only a freshly locked never-dispatched reservation with its held receipt, atomically', async () => {
    const person = await seedPerson(db()),
      item = await seeded(person, 'reserved');
    expect(await receipt(item.id)).toMatchObject({ state: 'held' });
    expect(await erase(person)).toMatchObject({
      kind: 'entered',
      value: [expect.objectContaining({ status: 'completed' })],
    });
    expect(await rows(person)).toEqual([]);
    expect(await receipt(item.id)).toMatchObject({ state: 'released', conclusive_failure: false });
    expect(
      await scope()(person.authority, (tx) =>
        ledger().commitDispatch(tx, item.id, {
          dispatchId: randomUUID(),
          dispatchedBy: 'fixture',
          quota: { verdict: 'available', intervalRemainingPercent: 100, weeklyRemainingPercent: 100 },
        }),
      ),
    ).toEqual({ kind: 'entered', value: false });
  });

  for (const invalid of ['dispatch_identity', 'missing_receipt', 'mismatched_receipt'] as const) {
    it(`retains/redacts an unproved reserved liability (${invalid}) rather than deletion-based release`, async () => {
      const person = await seedPerson(db()),
        item = await seeded(person, 'reserved');
      if (invalid === 'dispatch_identity')
        await db()
          .updateTable('reasoning.external_attempts')
          .set({ dispatch_id: randomUUID() })
          .where('id', '=', item.id)
          .execute();
      else if (invalid === 'missing_receipt')
        await db().deleteFrom('reasoning.usage_receipts').where('attempt_id', '=', item.id).execute();
      else
        await db()
          .updateTable('reasoning.usage_receipts')
          .set({ reserved_tokens: 149 })
          .where('attempt_id', '=', item.id)
          .execute();
      expect(await erase(person)).toMatchObject({
        kind: 'entered',
        value: [expect.objectContaining({ status: 'pending' })],
      });
      expect((await redacted(person)).state).toBe('reserved');
      if (invalid === 'dispatch_identity') {
        expect(await receipt(item.id)).toMatchObject({ state: 'held' });
        expect(await scope()(person.authority, (tx) => ledger().budgetUsage(tx, 'fixture.privacy'))).toMatchObject({
          kind: 'entered',
          value: {
            scope: { requests: 1, tokens: 150 },
            global: { requests: 1, tokens: 150 },
            role: { requests: 1, tokens: 150 },
          },
        });
      } else {
        await expect(scope()(person.authority, (tx) => ledger().budgetUsage(tx, 'fixture.privacy'))).rejects.toThrow(
          'Reasoning accounting receipt unavailable',
        );
        if (invalid === 'mismatched_receipt')
          expect(await receipt(item.id)).toMatchObject({ state: 'held', reserved_tokens: 149 });
      }
      expect(
        await scope()(person.authority, (tx) =>
          ledger().commitDispatch(tx, item.id, {
            dispatchId: randomUUID(),
            dispatchedBy: 'fixture',
            quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
          }),
        ),
      ).toEqual({ kind: 'entered', value: false });
    });
  }

  it('preserves no-usage answer charges and brake truth using receipts after payload stripping', async () => {
    const person = await seedPerson(db()),
      item = await seeded(person, 'unknown');
    await erase(person);
    expect(
      await ledger().settle(item.ref, 'unknown', 'reconciled', {
        outcomeCode: 'private-fixture-canary',
        issues: { v: 1, reason: 'private-fixture-canary', issues: [] },
      }),
    ).toBe(true);
    const after = await redacted(person);
    expect(after.outcome_code).toBeNull();
    expect(await receipt(item.id)).toMatchObject({
      state: 'settled',
      input_tokens: null,
      output_tokens: null,
      reserved_tokens: 150,
      conclusive_failure: false,
    });
    expect(await scope()(person.authority, (tx) => ledger().budgetUsage(tx, 'fixture.privacy'))).toEqual({
      kind: 'entered',
      value: {
        global: { requests: 1, tokens: 150 },
        role: { requests: 1, tokens: 150 },
        scope: { requests: 1, tokens: 150 },
        // An interactive role, so none of this counts against the background share.
        background: { global: { requests: 0, tokens: 0 }, scope: { requests: 0, tokens: 0 } },
        ambient: { global: { requests: 0, tokens: 0 } },
      },
    });
  });

  it('records late usage on a written-off receipt even after its personal row was erased, without another send', async () => {
    const person = await seedPerson(db()),
      entered = gate(),
      release = gate<FixtureScenario>();
    const model = fixtureModel(() => {
      entered.open();
      return { kind: 'hold', until: release.promise };
    });
    const { harness, ports } = fixtureHarness(db(), { model });
    const running = propose(harness, person);
    await entered.promise;
    const [row] = await rows(person);
    const ref = { scopeId: person.universeId, attemptId: row!.id };
    await erase(person);
    expect(await ports.ledger.settle(ref, 'dispatched', 'unknown', { outcomeCode: 'TRANSPORT_OUTCOME_UNKNOWN' })).toBe(
      true,
    );
    expect(await ports.ledger.writeOff(row!.id, 'private-fixture-canary', 'cli:private-fixture-canary')).toMatchObject({
      kind: 'written_off',
    });
    expect(await redacted(person)).toMatchObject({
      written_off_reason: 'privacy-erased',
      written_off_by: 'privacy-erased',
    });
    await erase(person);
    expect(await rows(person)).toEqual([]);
    release.open({
      kind: 'success',
      text: '{"ok":true,"echo":"private-fixture-canary"}',
      usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 2 },
    });
    expect((await running).kind).not.toBe('proposed');
    expect(await receipt(row!.id)).toMatchObject({
      state: 'written_off',
      late_usage: true,
      input_tokens: 7,
      output_tokens: 3,
      cached_tokens: 2,
    });
    await ports.ledger.recordLateUsage(row!.id, {
      inputTokens: 999,
      outputTokens: 999,
      cachedTokens: 999,
      reasoningTokens: null,
    });
    expect(await receipt(row!.id)).toMatchObject({ input_tokens: 7, output_tokens: 3, cached_tokens: 2 });
    expect(model.calls).toHaveLength(1);
  });

  it('rolls back marker, protected deletion and reserved receipt release together', async () => {
    const person = await seedPerson(db()),
      item = await seeded(person, 'reserved');
    const before = await rows(person),
      paid = await receipt(item.id);
    await expect(
      scope()(person.authority, async (tx) => {
        await reasoning.erase(tx);
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
    expect(await rows(person)).toEqual(before);
    expect(await receipt(item.id)).toEqual(paid);
    expect(await ledger().readProtectedRequest(item.ref)).toBeInstanceOf(Uint8Array);
  });

  it('SQL refuses private payload or arbitrary codes and immutable-marker clearing on marked rows', async () => {
    const person = await seedPerson(db()),
      item = await seeded(person, 'unknown');
    await erase(person);
    await expect(
      sql`update reasoning.external_attempts set state='succeeded', output='{"v":1,"text":"private-fixture-canary"}'::jsonb where id=${item.id}`.execute(
        db(),
      ),
    ).rejects.toMatchObject({ constraint: 'external_attempts_privacy_erased_check' });
    await expect(
      db()
        .updateTable('reasoning.external_attempts')
        .set({ outcome_code: 'SUCCEEDED_private-fixture-canary' })
        .where('id', '=', item.id)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'external_attempts_privacy_erased_check' });
    await expect(
      db()
        .updateTable('reasoning.external_attempts')
        .set({ privacy_erased_at: null })
        .where('id', '=', item.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db()
        .updateTable('reasoning.business_runs')
        .set({ context_bundle_ref: 'private-fixture-canary' })
        .where('id', '=', item.runId)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'business_runs_privacy_erased_check' });
    const before = await redacted(person);
    await erase(person);
    expect((await redacted(person)).privacy_erased_at).toEqual(before.privacy_erased_at);
  });

  it('a quota callback that ignores cancellation cannot dispatch a reservation released by erasure', async () => {
    const person = await seedPerson(db()),
      entered = gate(),
      release = gate();
    const model = fixtureModel();
    const held = guardedModelPort({
      ...model,
      async observeQuota() {
        entered.open();
        await release.promise;
        return { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null };
      },
    });
    const { harness } = fixtureHarness(db(), { model: held });
    const running = propose(harness, person);
    await entered.promise;
    const [before] = await rows(person);
    expect(before?.state).toBe('reserved');
    await erase(person);
    release.open();
    expect((await running).kind).toBe('refused');
    expect(model.calls).toHaveLength(0);
    expect(await rows(person)).toEqual([]);
    expect(await receipt(before!.id)).toMatchObject({ state: 'released' });
  });

  it('privacy after committed dispatch but before send keeps liability and accounts the one late invocation', async () => {
    const person = await seedPerson(db()),
      committed = gate(),
      resume = gate();
    const model = fixtureModel();
    const base = fixtureHarness(db(), { model });
    const withScope = base.ports.withPersonalScope;
    let dispatchCommitted = false,
      stopped = false;
    const { harness } = fixtureHarness(db(), {
      model,
      overrides: {
        ledger: {
          ...base.ports.ledger,
          async commitDispatch(scope, attemptId, dispatch) {
            const won = await base.ports.ledger.commitDispatch(scope, attemptId, dispatch);
            dispatchCommitted ||= won;
            return won;
          },
        },
        withPersonalScope: async (authority, work) => {
          const value = await withScope(authority, work);
          // Target the actual committed dispatch, not an entry count changed by privacy reads.
          if (dispatchCommitted && !stopped) {
            stopped = true;
            committed.open();
            await resume.promise;
          }
          return value;
        },
      },
    });
    const running = propose(harness, person);
    await committed.promise;
    expect(model.calls).toHaveLength(0);
    await erase(person);
    const before = await redacted(person);
    expect(before.state).toBe('dispatched');
    expect(await receipt(before.id)).toMatchObject({ state: 'held' });
    resume.open();
    expect(await running).toMatchObject({ kind: 'refused', reason: 'output_ineligible' });
    expect(model.calls).toHaveLength(1);
    expect(await receipt(before.id)).toMatchObject({ state: 'settled' });
    await redacted(person);
  });

  it('retains exactly the seven fixed accounting codes, never prefix-matching provider text', async () => {
    for (const code of [
      'OUTCOME_NOT_RECORDED',
      'TRANSPORT_OUTCOME_UNKNOWN',
      'AUTHORITY_REFUSED',
      'QUOTA_UNAVAILABLE',
      'SUCCEEDED',
      'REJECTED',
      'REQUEST_EXPIRED',
    ]) {
      const person = await seedPerson(db()),
        item = await seeded(person, 'unknown');
      await db()
        .updateTable('reasoning.external_attempts')
        .set({ outcome_code: code })
        .where('id', '=', item.id)
        .execute();
      await erase(person);
      expect((await redacted(person)).outcome_code).toBe(code);
      await expect(
        db()
          .updateTable('reasoning.external_attempts')
          .set({ outcome_code: code + '_PRIVATE' })
          .where('id', '=', item.id)
          .execute(),
      ).rejects.toMatchObject({ constraint: 'external_attempts_privacy_erased_check' });
    }
  });

  async function blockedBy(pid: number) {
    await vi.waitFor(
      async () => {
        const result = await sql<{ blocked: boolean }>`select exists (
        select 1 from pg_stat_activity a where a.datname=current_database()
        and ${pid} = any(pg_blocking_pids(a.pid))) as blocked`.execute(db());
        expect(result.rows[0]?.blocked).toBe(true);
      },
      { timeout: 3000, interval: 10 },
    );
  }

  it('actual settlement holds its attempt while waiting on a receipt; erasure then sees its committed terminal state', async () => {
    const person = await seedPerson(db()),
      item = await seeded(person);
    const locked = gate<number>(),
      release = gate();
    const holding = withTransaction(db(), 'privacy-ci-receipt-lock', async (trx) => {
      await sql`select attempt_id from reasoning.usage_receipts where attempt_id=${item.id} for update`.execute(trx);
      locked.open((await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid);
      await release.promise;
    });
    const receiptPID = await locked.promise;
    const settling = ledger().settle(item.ref, 'dispatched', 'succeeded', {
      output: { v: 1, text: 'private-fixture-canary' },
    });
    let erasing: ReturnType<typeof erase> | undefined;
    try {
      await blockedBy(receiptPID);
      const blocked = await sql<{ pid: number }>`select a.pid from pg_stat_activity a
        where a.datname=current_database() and ${receiptPID}=any(pg_blocking_pids(a.pid))`.execute(db());
      expect(blocked.rows).toHaveLength(1);
      erasing = erase(person);
      await blockedBy(blocked.rows[0]!.pid);
    } finally {
      release.open();
      await holding;
    }
    expect(await settling).toBe(true);
    await expect(erasing).resolves.toMatchObject({
      kind: 'entered',
      value: [expect.objectContaining({ status: 'completed' })],
    });
    expect(await rows(person)).toEqual([]);
    expect(await receipt(item.id)).toMatchObject({ state: 'settled', conclusive_failure: false, reserved_tokens: 150 });
  });

  it('settlement waits behind actual eraser attempt lock and sees the committed marker after waiting', async () => {
    const person = await seedPerson(db()),
      item = await seeded(person);
    const locked = gate<number>(),
      release = gate();
    const erasing = scope()(person.authority, async (tx) => {
      await reasoning.erase(tx);
      locked.open((await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transactionOf(tx))).rows[0]!.pid);
      await release.promise;
    });
    const pid = await locked.promise;
    const settling = ledger().settle(item.ref, 'dispatched', 'succeeded', {
      output: { v: 1, text: 'private-fixture-canary' },
    });
    try {
      await blockedBy(pid);
    } finally {
      release.open();
      await erasing;
    }
    expect(await settling).toBe(true);
    await redacted(person);
  });

  for (const maintenance of ['write_off', 'stale_sweep', 'request_purge'] as const) {
    const state = maintenance === 'write_off' ? 'unknown' : maintenance === 'request_purge' ? 'reserved' : 'dispatched';
    const maintain = (id: string) =>
      maintenance === 'write_off'
        ? ledger().writeOff(id, 'private-fixture-canary', 'private-fixture-canary')
        : maintenance === 'stale_sweep'
          ? ledger().sweepStaleDispatched(1, 1)
          : ledger().purgeExpiredRequests(1);
    const eligible = async (id: string) => {
      if (maintenance === 'stale_sweep')
        await sql`update reasoning.external_attempts set dispatched_at=now()-interval '1 hour' where id=${id}`.execute(
          db(),
        );
      if (maintenance === 'request_purge')
        await sql`update reasoning.protected_requests set created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' where attempt_id=${id}`.execute(
          db(),
        );
    };
    const charged = async (person: FixturePerson, id: string, receiptState: string) => {
      expect(await receipt(id)).toMatchObject({ state: receiptState, reserved_tokens: 150, conclusive_failure: false });
      const usage = await scope()(person.authority, (tx) => ledger().budgetUsage(tx, 'fixture.privacy'));
      expect(usage).toMatchObject({
        kind: 'entered',
        value: {
          global: { requests: receiptState === 'released' ? 0 : 1, tokens: receiptState === 'released' ? 0 : 150 },
          role: { requests: receiptState === 'released' ? 0 : 1, tokens: receiptState === 'released' ? 0 : 150 },
        },
      });
    };

    it(`actual ${maintenance} locks attempt before receipt; erasure waits and consumes committed accounting`, async () => {
      const person = await seedPerson(db()),
        item = await seeded(person, state);
      await eligible(item.id);
      const locked = gate<number>(),
        release = gate();
      const holding = withTransaction(db(), 'privacy-ci-maintenance-receipt', async (trx) => {
        await sql`select attempt_id from reasoning.usage_receipts where attempt_id=${item.id} for update`.execute(trx);
        locked.open((await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid);
        await release.promise;
      });
      const receiptPID = await locked.promise,
        maintaining = maintain(item.id);
      let erasing: ReturnType<typeof erase> | undefined;
      try {
        await blockedBy(receiptPID);
        const waiting = await sql<{
          pid: number;
        }>`select a.pid from pg_stat_activity a where a.datname=current_database()
          and ${receiptPID}=any(pg_blocking_pids(a.pid))`.execute(db());
        expect(waiting.rows).toHaveLength(1);
        erasing = erase(person);
        await blockedBy(waiting.rows[0]!.pid);
      } finally {
        release.open();
        await holding;
      }
      if (maintenance === 'write_off') expect(await maintaining).toMatchObject({ kind: 'written_off' });
      else expect(await maintaining).toBe(1);
      await expect(erasing).resolves.toMatchObject({ kind: 'entered' });
      if (maintenance === 'stale_sweep') {
        expect((await redacted(person)).state).toBe('unknown');
        expect((await redacted(person)).outcome_code).toBe('OUTCOME_NOT_RECORDED');
      } else expect(await rows(person)).toEqual([]);
      await charged(
        person,
        item.id,
        maintenance === 'write_off' ? 'written_off' : maintenance === 'stale_sweep' ? 'unknown' : 'released',
      );
    });

    it(`actual erasure locks first; ${maintenance} cannot invert locks, resurrect payload, or refund an open liability`, async () => {
      const person = await seedPerson(db()),
        item = await seeded(person, state);
      await eligible(item.id);
      const locked = gate<number>(),
        release = gate();
      const erasing = scope()(person.authority, async (tx) => {
        await reasoning.erase(tx);
        locked.open(
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transactionOf(tx))).rows[0]!.pid,
        );
        await release.promise;
      });
      const pid = await locked.promise,
        maintaining = maintain(item.id);
      try {
        if (maintenance === 'write_off') await blockedBy(pid);
        else expect(await maintaining).toBe(0); // SKIP LOCKED must complete while erasure owns the rows.
      } finally {
        release.open();
        await erasing;
      }
      if (maintenance === 'write_off') {
        expect(await maintaining).toMatchObject({ kind: 'written_off' });
        expect(await redacted(person)).toMatchObject({
          state: 'written_off',
          written_off_reason: 'privacy-erased',
          written_off_by: 'privacy-erased',
        });
      } else if (maintenance === 'stale_sweep') {
        expect((await redacted(person)).state).toBe('dispatched');
        expect(await receipt(item.id)).toMatchObject({ state: 'held', reserved_tokens: 150 });
        // A later maintenance pass after the committed marker may classify unknown, never resend/release.
        expect(await maintain(item.id)).toBe(1);
        expect((await redacted(person)).state).toBe('unknown');
      } else expect(await rows(person)).toEqual([]);
      await charged(
        person,
        item.id,
        maintenance === 'write_off' ? 'written_off' : maintenance === 'stale_sweep' ? 'unknown' : 'released',
      );
    });
  }
});
