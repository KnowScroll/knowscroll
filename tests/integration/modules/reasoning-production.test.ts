import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import {
  makeWithPersonalScope,
  makeWithProductionScope,
  productionTransactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import type { ProductionAuthority, ProductionScopeTx, ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  reasoningOperatorFor,
  type HarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  fixtureSettings,
  gate,
  signal,
  silent,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';

const authority: ProductionAuthority = { scopeId: 'scroll-supply', generation: 1 };
const success: FixtureScenario = { kind: 'success', text: '{"ok":true,"echo":"lantern"}' };
const role = (name: string): ReasoningRole<unknown> => ({ ...echoRole, id: `fixture.${name}` });

/** CI fixture + real database. No provider/quota network access. */
describe('nonpersonal production execution and shared failure brake', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('production');
  });
  afterAll(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const scope = (enabled = true) => makeWithProductionScope(db(), { enabled, lockTimeoutMs: 5_000 });
  const root = (enabled = true, generation = 1) =>
    db()
      .updateTable('reasoning.production_scopes')
      .set({ enabled, generation })
      .where('id', '=', 'scroll-supply')
      .execute();
  const run = (id = randomUUID(), claimed = authority) => ({
    id,
    authority: claimed,
    ownerModule: 'content',
    purpose: 'fixture-scroll',
    policyVersion: 'fixture.v1',
  });
  const production = (model = fixtureModel(), options: { enabled?: boolean; settings?: HarnessSettings } = {}) => {
    const enabled = options.enabled ?? true;
    const ports = postgresProductionHarnessPorts({
      db: db(),
      withProductionScope: scope(enabled),
      enabled,
      model,
      logEvent: silent,
      settings: options.settings ?? fixtureSettings,
    });
    return { ports, harness: makeProductionReasoningHarness(ports), model };
  };
  const propose = (p: ReturnType<typeof production>, r = run(), selected: ReasoningRole<unknown> = echoRole) =>
    p.harness.proposeProduction({ run: r, role: selected, context: fixtureContext }, signal());
  const productionRows = (runId: string) =>
    db()
      .selectFrom('reasoning.production_attempts')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('reserved_at')
      .orderBy('id')
      .execute();
  const slots = async (roleId: string) => {
    const result = await sql<{ count: string }>`select count(*)::text as count from reasoning.usage_receipts
      where role_id = ${roleId} and budget_window = (now() at time zone 'UTC')::date
      and (conclusive_failure or state in ('held', 'unknown', 'written_off'))`.execute(db());
    return Number(result.rows[0]?.count ?? 0);
  };

  it('requires both the database root and explicit worker grant before even quota preflight', async () => {
    const p = production();
    expect(await propose(p)).toEqual({ kind: 'refused', reason: 'scope_refused' });
    await root();
    const disabled = production(p.model, { enabled: false });
    expect(await propose(disabled)).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(p.model.quotaChecks()).toBe(0);
    expect(p.model.calls).toHaveLength(0);
  });

  it('stores supply without a universe and survives personal erasure; personal and production IDs stay separate', async () => {
    const person = await seedPerson(db());
    const id = randomUUID();
    const p = production();
    expect(await propose(p, run(id))).toMatchObject({ kind: 'proposed' });
    const personal = fixtureHarness(db(), { model: fixtureModel() }).harness;
    expect(
      await personal.propose(
        { run: fixtureRun(systemAuthority(person.universeId), id), role: echoRole, context: fixtureContext },
        signal(),
      ),
    ).toMatchObject({ kind: 'proposed' });
    await makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(person.authority, (tx) =>
      eraseUniverse(tx, personalStores),
    );
    expect(await productionRows(id)).toHaveLength(1);
    const requests = await db()
      .selectFrom('reasoning.production_requests')
      .select(['erasure_class', 'body_sha256'])
      .where('attempt_id', '=', (await productionRows(id))[0]?.id ?? '')
      .execute();
    expect(requests).toEqual([expect.objectContaining({ erasure_class: 'nonpersonal_production' })]);
    const fks = await sql<{ referenced: string }>`select confrelid::regclass::text as referenced from pg_constraint
      where conrelid in ('reasoning.production_runs'::regclass, 'reasoning.production_attempts'::regclass,
      'reasoning.production_requests'::regclass) and contype = 'f'`.execute(db());
    expect(fks.rows.every((row) => row.referenced.startsWith('reasoning.production_'))).toBe(true);
    expect(await propose(p, run(id))).toMatchObject({ kind: 'proposed' });
    expect(p.model.calls).toHaveLength(1);
  });

  it('rechecks generation after a root lock wait, and expires the capability after the transaction', async () => {
    const entered = gate();
    const release = gate();
    let kept: ProductionScopeTx | undefined;
    const holding = scope()(authority, async (tx) => {
      kept = tx;
      entered.open();
      await release.promise;
      await productionTransactionOf(tx)
        .updateTable('reasoning.production_scopes')
        .set({ generation: 2 })
        .where('id', '=', authority.scopeId)
        .execute();
    });
    await entered.promise;
    const pending = propose(production(), run());
    release.open();
    await holding;
    expect(await pending).toEqual({ kind: 'refused', reason: 'scope_refused' });
    if (kept === undefined) throw new Error('scope not captured');
    const closedScope = kept;
    expect(() => productionTransactionOf(closedScope)).toThrow('Production scope used after its transaction ended');
    await root();
  });

  it('records a paid answer after disabling/replacing the generation but never hands it to an applier', async () => {
    const entered = gate();
    const release = gate<FixtureScenario>();
    const p = production(
      fixtureModel(() => {
        entered.open();
        return { kind: 'hold', until: release.promise };
      }),
    );
    const r = run();
    const running = propose(p, r);
    await entered.promise;
    await root(false, 2);
    release.open(success);
    expect(await running).toMatchObject({ kind: 'refused', reason: 'output_ineligible' });
    expect((await productionRows(r.id))[0]).toMatchObject({ state: 'succeeded', input_tokens: 40 });
    expect(await propose(p, run(r.id, { ...authority, generation: 2 }))).toEqual({
      kind: 'refused',
      reason: 'run_mismatch',
    });
    expect(await scope()({ ...authority, generation: 2 }, () => Promise.resolve('applied'))).toMatchObject({
      kind: 'refused',
    });
    await root();
  });

  it('guards model network and nested personal entry inside the production transaction', async () => {
    const model = fixtureModel();
    await expect(scope()(authority, () => model.observeQuota(signal()))).rejects.toMatchObject({
      code: 'NETWORK_IN_TRANSACTION',
    });
    await expect(
      scope()(authority, () =>
        makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(systemAuthority(randomUUID()), () =>
          Promise.resolve('nested'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NESTED_TRANSACTION' });
    expect(model.quotaChecks()).toBe(0);
  });

  it('rolls attempt, exact protected bytes, receipt and run back together on reservation failure', async () => {
    const p = production();
    const r = run();
    const beforeReceipts = await db()
      .selectFrom('reasoning.usage_receipts')
      .select('attempt_id')
      .orderBy('attempt_id')
      .execute();
    const beforeRequests = await db()
      .selectFrom('reasoning.production_requests')
      .select('attempt_id')
      .orderBy('attempt_id')
      .execute();
    const harness = makeProductionReasoningHarness({
      ...p.ports,
      ledger: {
        ...p.ports.ledger,
        async reserve(tx, reservation) {
          await p.ports.ledger.reserve(tx, reservation);
          throw new Error('fixture reserve crash');
        },
      },
    });
    await expect(
      harness.proposeProduction({ run: r, role: echoRole, context: fixtureContext }, signal()),
    ).rejects.toThrow('fixture reserve crash');
    expect(await productionRows(r.id)).toEqual([]);
    expect(await db().selectFrom('reasoning.production_runs').select('id').where('id', '=', r.id).execute()).toEqual(
      [],
    );
    expect(
      await db().selectFrom('reasoning.usage_receipts').select('attempt_id').orderBy('attempt_id').execute(),
    ).toEqual(beforeReceipts);
    expect(
      await db().selectFrom('reasoning.production_requests').select('attempt_id').orderBy('attempt_id').execute(),
    ).toEqual(beforeRequests);
    expect(p.model.calls).toHaveLength(0);
  });

  it('closes production runs atomically with domain effects; rollback preserves the fence and redelivery never resends', async () => {
    const p = production();
    const r = run();
    expect(await propose(p, r)).toMatchObject({ kind: 'proposed' });
    await expect(
      scope()(authority, async (tx) => {
        expect(await p.harness.closeProductionRun(tx, { runId: r.id, state: 'completed' })).toBe('closed');
        throw new Error('fixture domain rollback');
      }),
    ).rejects.toThrow('fixture domain rollback');
    expect(
      await db()
        .selectFrom('reasoning.production_runs')
        .select(['state', 'fence'])
        .where('id', '=', r.id)
        .executeTakeFirst(),
    ).toEqual({ state: 'admitted', fence: 1 });
    expect(
      await scope()(authority, (tx) => p.harness.closeProductionRun(tx, { runId: r.id, state: 'completed' })),
    ).toEqual({ kind: 'entered', value: 'closed' });
    expect(
      await scope()(authority, (tx) => p.harness.closeProductionRun(tx, { runId: r.id, state: 'completed' })),
    ).toEqual({ kind: 'entered', value: 'not_open' });
    expect(await propose(p, r)).toEqual({ kind: 'refused', reason: 'run_closed' });
    expect(p.model.calls).toHaveLength(1);
  });

  it('shares role/global accounting across personal and production while retaining the separate scope cap', async () => {
    const selected = { ...role('shared-budget'), budget: { requestsPerDay: 1, tokensPerDay: 1_000_000 } };
    const person = await seedPerson(db());
    const personal = fixtureHarness(db(), { model: fixtureModel() }).harness;
    expect(
      await personal.propose({ run: fixtureRun(person.authority), role: selected, context: fixtureContext }, signal()),
    ).toMatchObject({ kind: 'proposed' });
    expect(await propose(production(), run(), selected)).toEqual({
      kind: 'budget_exhausted',
      dimension: 'role',
      limit: 'requests',
    });
    const globalUsed = await db()
      .selectFrom('reasoning.usage_receipts')
      .select('attempt_id')
      .where('state', '!=', 'released')
      .where('budget_window', '=', sql<Date>`(now() at time zone 'UTC')::date`)
      .execute();
    const settings = {
      ...fixtureSettings,
      caps: { ...fixtureSettings.caps, global: { requestsPerDay: globalUsed.length, tokensPerDay: 1_000_000_000 } },
    };
    expect(await propose(production(fixtureModel(), { settings }), run(), role('global-budget'))).toEqual({
      kind: 'budget_exhausted',
      dimension: 'global',
      limit: 'requests',
    });
  });

  it('sweeps production crashes, lists/write-offs liabilities, keeps unknown reservations, and purges exact bytes', async () => {
    const p = production();
    const r = run();
    const harness = makeProductionReasoningHarness({
      ...p.ports,
      ledger: {
        ...p.ports.ledger,
        settle: (attempt, from, to, details) =>
          from === 'dispatched'
            ? Promise.reject(new Error('fixture settlement crash'))
            : p.ports.ledger.settle(attempt, from, to, details),
      },
    });
    await expect(
      harness.proposeProduction({ run: r, role: role('production-crash'), context: fixtureContext }, signal()),
    ).rejects.toThrow('fixture settlement crash');
    const attemptId = (await productionRows(r.id))[0]?.id ?? '';
    await sql`update reasoning.production_attempts set dispatched_at = now() - interval '1 hour' where id = ${attemptId}`.execute(
      db(),
    );
    await sql`update reasoning.production_requests set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where attempt_id = ${attemptId}`.execute(
      db(),
    );
    const operator = reasoningOperatorFor(db(), silent);
    await operator.purgeExpired();
    expect(
      await db()
        .selectFrom('reasoning.production_requests')
        .select('attempt_id')
        .where('attempt_id', '=', attemptId)
        .execute(),
    ).toHaveLength(1);
    expect(await operator.sweepStaleDispatched(1)).toBeGreaterThanOrEqual(1);
    expect((await operator.listUnknown(500)).map((row) => row.attemptId)).toContain(attemptId);
    expect(await propose(p, r, role('production-crash'))).toMatchObject({ kind: 'unknown', attemptId });
    expect(await slots('fixture.production-crash')).toBe(1);
    expect(await operator.writeOff(attemptId, 'CI fixture unknown liability', 'cli:ci-fixture')).toEqual({
      kind: 'written_off',
      attemptId,
    });
    await p.ports.ledger.recordLateUsage(attemptId, {
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: null,
      reasoningTokens: null,
    });
    expect(await slots('fixture.production-crash')).toBe(1);
    await operator.purgeExpired();
    expect(
      await db()
        .selectFrom('reasoning.production_requests')
        .select('attempt_id')
        .where('attempt_id', '=', attemptId)
        .execute(),
    ).toEqual([]);
    expect(p.model.calls).toHaveLength(1);
  });

  it('bounds refunded failing new runs across instances/personal/production and survives personal erasure', async () => {
    const selected = role('shared-failure');
    const model = fixtureModel(() => ({ kind: 'rate_limited' }));
    const person = await seedPerson(db());
    const personal = fixtureHarness(db(), { model }).harness;
    const oldRun = fixtureRun(person.authority);
    for (let index = 0; index < 5; index += 1) {
      const result =
        index % 2 === 0
          ? await personal.propose(
              { run: index === 0 ? oldRun : fixtureRun(person.authority), role: selected, context: fixtureContext },
              signal(),
            )
          : await propose(production(model), run(), selected);
      expect(result).toMatchObject({ kind: 'failed' });
    }
    expect(await slots(selected.id)).toBe(5);
    expect(await propose(production(model), run(), selected)).toEqual({ kind: 'refused', reason: 'failure_brake' });
    expect(await personal.propose({ run: oldRun, role: selected, context: fixtureContext }, signal())).toMatchObject({
      kind: 'failed',
    });
    await makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(person.authority, (tx) =>
      eraseUniverse(tx, personalStores),
    );
    expect(await slots(selected.id)).toBe(5);
    expect(await propose(production(model), run(), selected)).toEqual({ kind: 'refused', reason: 'failure_brake' });
    const receipts = await db()
      .selectFrom('reasoning.usage_receipts')
      .select(['attempt_id', 'state', 'conclusive_failure'])
      .where('role_id', '=', selected.id)
      .execute();
    expect(receipts).toHaveLength(5);
    expect(receipts.every((row) => row.state === 'released' && row.conclusive_failure)).toBe(true);
    // The reservation's UTC day, not process clock/timezone, releases the prior day's slot.
    await sql`update reasoning.usage_receipts set budget_window = (now() at time zone 'UTC')::date - 1
      where attempt_id = ${receipts[0]?.attempt_id ?? ''}`.execute(db());
    expect(await propose(production(model), run(), selected)).toMatchObject({ kind: 'failed' });
    expect(model.calls).toHaveLength(6);
  });

  it('serialises cross-scope new-run admission before transport so a concurrent failure burst occupies exactly five slots', async () => {
    const selected = role('failure-race');
    const release = gate<FixtureScenario>();
    const refusals = gate();
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const people = await Promise.all(Array.from({ length: 6 }, () => seedPerson(db())));
    let refused = 0;
    const running = Array.from({ length: 12 }, (_, index) => {
      const person = people[index % 6];
      if (person === undefined) throw new Error('fixture person missing');
      const result =
        index < 6
          ? propose(production(model), run(), selected)
          : fixtureHarness(db(), { model }).harness.propose(
              { run: fixtureRun(person.authority), role: selected, context: fixtureContext },
              signal(),
            );
      return result.then((outcome) => {
        if (outcome.kind === 'refused' && outcome.reason === 'failure_brake' && ++refused === 7) refusals.open();
        return outcome;
      });
    });
    try {
      await refusals.promise;
      expect(await slots(selected.id)).toBe(5);
    } finally {
      release.open({ kind: 'server_error', status: 503 });
    }
    const outcomes = await Promise.all(running);
    expect(outcomes.filter((outcome) => outcome.kind === 'failed')).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.kind === 'refused')).toHaveLength(7);
    expect(model.calls).toHaveLength(5);
    expect(await propose(production(model), run(), selected)).toEqual({ kind: 'refused', reason: 'failure_brake' });
  });

  it('rechecks the failure brake before replacing quota-stopped primary attempts', async () => {
    const selected = role('replacement-brake');
    let quotaAvailable = false;
    const model = fixtureModel(() => ({ kind: 'rate_limited' }), {
      quota: () => ({
        verdict: quotaAvailable ? 'not_applicable' : 'unavailable',
        intervalRemainingPercent: null,
        weeklyRemainingPercent: null,
      }),
    });
    const runs = Array.from({ length: 6 }, () => run());
    for (const pendingRun of runs)
      expect(await propose(production(model), pendingRun, selected)).toMatchObject({ kind: 'quota_unavailable' });
    expect(await slots(selected.id)).toBe(0);
    expect(model.calls).toHaveLength(0);

    quotaAvailable = true;
    for (const pendingRun of runs.slice(0, 5))
      expect(await propose(production(model), pendingRun, selected)).toMatchObject({ kind: 'failed' });
    expect(await slots(selected.id)).toBe(5);
    const blocked = runs[5];
    const settled = runs[0];
    if (blocked === undefined || settled === undefined) throw new Error('fixture run missing');
    expect(await propose(production(model), blocked, selected)).toEqual({ kind: 'refused', reason: 'failure_brake' });
    expect((await productionRows(blocked.id)).map((row) => row.state)).toEqual(['not_sent']);
    // An already settled answer still replays without spending or requiring a new brake slot.
    expect(await propose(production(model), settled, selected)).toMatchObject({ kind: 'failed' });
    expect(model.calls).toHaveLength(5);
  });

  it('counts only one slot through invalid-primary repair, and none for replaced not-sent attempts', async () => {
    const selected = role('repair-slots');
    const entered = gate();
    const release = gate<FixtureScenario>();
    const p = production(
      fixtureModel((sequence) => {
        if (sequence === 1) return { kind: 'malformed' };
        entered.open();
        return { kind: 'hold', until: release.promise };
      }),
    );
    const r = run();
    const pending = propose(p, r, selected);
    await entered.promise;
    expect(await slots(selected.id)).toBe(1);
    release.open({ kind: 'rate_limited' });
    expect(await pending).toMatchObject({ kind: 'failed' });
    expect(await slots(selected.id)).toBe(1);
    expect((await productionRows(r.id)).map((row) => row.step)).toEqual(['primary', 'repair']);
    const quotaRole = role('not-sent-slots');
    let observations = 0;
    const q = production(
      fixtureModel(undefined, {
        quota: () => ({
          verdict: ++observations === 1 ? 'unavailable' : 'not_applicable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        }),
      }),
    );
    const qr = run();
    expect(await propose(q, qr, quotaRole)).toMatchObject({ kind: 'quota_unavailable' });
    expect(await slots(quotaRole.id)).toBe(0);
    expect(await propose(q, qr, quotaRole)).toMatchObject({ kind: 'proposed' });
    expect(await slots(quotaRole.id)).toBe(0);
    expect((await productionRows(qr.id)).map((row) => row.state)).toEqual(['not_sent', 'succeeded']);
  });

  it('returns primary plus repair accounting without payloads and fences expired/foreign generations', async () => {
    await root();
    const p = production(fixtureModel((n) => (n === 1 ? { kind: 'malformed' } : success)));
    const r = run();
    expect(await propose(p, r, role('accounting'))).toMatchObject({ kind: 'proposed', repaired: true });
    let kept: ProductionScopeTx | undefined;
    const result = await scope()(authority, async (tx) => {
      kept = tx;
      return p.harness.readProductionRunAccounting(tx, r.id);
    });
    expect(result.kind).toBe('entered');
    if (result.kind !== 'entered' || result.value.kind !== 'accounted') throw new Error('accounting fixture missing');
    expect(result.value.attempts.map((attempt) => attempt.step)).toEqual(['primary', 'repair']);
    expect(result.value.attempts.map((attempt) => attempt.state)).toEqual(['succeeded', 'succeeded']);
    expect(result.value.attempts.reduce((total, attempt) => total + (attempt.usage.inputTokens ?? 0), 0)).toBe(80);
    for (const attempt of result.value.attempts) {
      expect(Object.keys(attempt).sort()).toEqual(['attemptId', 'model', 'provider', 'state', 'step', 'usage']);
      expect(Object.keys(attempt.usage).sort()).toEqual([
        'cachedTokens',
        'inputTokens',
        'outputTokens',
        'reasoningTokens',
      ]);
    }
    for (const privateText of ['lantern', 'context', 'output', 'request', 'quota', 'reason'])
      expect(JSON.stringify(result.value)).not.toContain(
        privateText === 'reason' ? 'written_off_reason' : `"${privateText}"`,
      );
    if (kept === undefined) throw new Error('scope fixture missing');
    await expect(p.harness.readProductionRunAccounting(kept, r.id)).rejects.toThrow(
      'Production scope used after its transaction ended',
    );
    await expect(p.harness.readProductionRunAccounting({} as ProductionScopeTx, r.id)).rejects.toThrow(
      'Production scope used after its transaction ended',
    );
    const fenced = await scope()(authority, async (tx) => {
      await productionTransactionOf(tx)
        .updateTable('reasoning.production_scopes')
        .set({ generation: 2 })
        .where('id', '=', authority.scopeId)
        .execute();
      return p.harness.readProductionRunAccounting(tx, r.id);
    });
    expect(fenced).toEqual({ kind: 'entered', value: { kind: 'refused', reason: 'generation_changed' } });
    expect(
      await scope()({ scopeId: 'scroll-supply', generation: 2 }, (tx) =>
        p.harness.readProductionRunAccounting(tx, r.id),
      ),
    ).toEqual({ kind: 'entered', value: { kind: 'not_found' } });
    await root();
  });

  it('refuses an accounting overflow rather than returning incomplete totals', async () => {
    await root();
    const p = production();
    const r = run();
    expect(await propose(p, r, role('accounting-bound'))).toMatchObject({ kind: 'proposed' });
    await db()
      .insertInto('reasoning.production_attempts')
      .values(
        Array.from({ length: 32 }, (_, n) => ({
          scope_id: authority.scopeId,
          id: randomUUID(),
          run_id: r.id,
          step: `fixture-extra-${n}`,
          provider: 'fixture',
          model: 'fixture-model-v1',
          request_hash: '0'.repeat(64),
          state: 'not_sent',
        })),
      )
      .execute();
    expect(await scope()(authority, (tx) => p.harness.readProductionRunAccounting(tx, r.id))).toEqual({
      kind: 'entered',
      value: { kind: 'refused', reason: 'accounting_limit' },
    });
  });
});
