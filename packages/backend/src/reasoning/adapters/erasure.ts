import type { ClearLiability } from '../../modules/identity/public.js';
import type { ClearReasoning } from '../public.js';
import {
  privacyTransactionOf,
  clearCoreTransactionOf,
  clearAccountingTransactionOf,
} from '../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import type { ModuleErasure } from '../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../infrastructure/postgres/personal-scope.js';
import { PRIVACY_ACCOUNTING_CODES } from './ledger-values.js';

/**
 * The reasoning engine's personal rows (blueprint §5 erasure registry, §15 accounting identity).
 *
 * - Protected request bytes: all of the universe's are deleted, including those of attempts whose
 *   outcome is still open — the bytes are private context, and the attempt's hash is enough to
 *   account for it.
 * - Retained liabilities are marked/redacted under the same attempt lock settlement takes.
 *   Only a freshly locked reserved row with no dispatch intent and its held receipt can be
 *   released. Dispatched/unknown and any unproved reservation remain pending, never refunded.
 * - Runs without remaining attempts are deleted.
 *
 * Outside our database: a request sent to MiniMax leaves a copy there (see `nonRowStores`).
 *
 * Usage receipts (`reasoning.usage_receipts`) are not personal: keyed by attempt ID only, with no
 * universe, purpose, context or output, they survive so global and per-role budgets stay honest
 * and late usage can still settle (blueprint §15 "minimal accounting identity").
 */
export const reasoningErasure: ModuleErasure = {
  module: 'reasoning',
  accountColumns: [{ schema: 'reasoning', table: 'business_runs', column: 'recording_account_id' }],
  tables: [
    { schema: 'reasoning', table: 'protected_requests', ownerColumn: 'universe_id' },
    { schema: 'reasoning', table: 'external_attempts', ownerColumn: 'universe_id' },
    { schema: 'reasoning', table: 'business_runs', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [
    {
      name: 'minimax/request-copies',
      description:
        "Copies of requests sent to MiniMax (bounded context items) and its answers, under MiniMax's own retention and terms (D-021); we keep no handle to find or delete them, so no eraser of ours reaches them and the privacy copy must say so",
    },
  ],
  async erase(scope) {
    const trx = transactionOf(scope);
    const universeId = scope.authority.universeId;
    // Root is already held. Parent-before-child ordering also matches purge/settlement; return
    // counts, not private rows or an unbounded JS payload list. Timeouts roll back the erasure.
    await sql`with locked as materialized (
      select id from reasoning.business_runs where universe_id = ${universeId}
      order by id for update
    ) select count(*) from locked`.execute(trx);
    await sql`with locked as materialized (
      select id from reasoning.external_attempts where universe_id = ${universeId}
      order by id for update
    ) select count(*) from locked`.execute(trx);
    await sql`with locked as materialized (
      select receipt.attempt_id from reasoning.usage_receipts receipt
      where exists (select 1 from reasoning.external_attempts attempt
        where attempt.universe_id = ${universeId} and attempt.id = receipt.attempt_id)
      order by receipt.attempt_id for update
    ) select count(*) from locked`.execute(trx);

    // The root excludes dispatch CAS, and the locked current state/identity/receipt prove no
    // dispatch intent ever committed. Missing/inconsistent proof stays held and pending.
    const released = await sql<{ attempts: string; receipts: string }>`
      with stopped as (
        update reasoning.external_attempts attempt
        set state = 'not_sent', outcome_code = 'AUTHORITY_REFUSED', settled_at = now()
        where attempt.universe_id = ${universeId} and attempt.state = 'reserved'
          and attempt.dispatch_id is null and attempt.dispatched_at is null
          and exists (select 1 from reasoning.usage_receipts receipt
            where receipt.attempt_id = attempt.id and receipt.state = 'held'
              and (receipt.role_id, receipt.role_version, receipt.provider, receipt.model,
                   receipt.budget_window, receipt.reserved_tokens) is not distinct from
                  (attempt.role_id, attempt.role_version, attempt.provider, attempt.model,
                   attempt.budget_window, attempt.reserved_tokens))
        returning attempt.id
      ), refunded as (
        update reasoning.usage_receipts set state = 'released', settled_at = now()
        where state = 'held' and attempt_id in (select id from stopped)
        returning attempt_id
      ) select (select count(*) from stopped)::text as attempts,
               (select count(*) from refunded)::text as receipts`.execute(trx);
    if (released.rows[0]?.attempts !== released.rows[0]?.receipts)
      throw new Error('Reasoning privacy reservation receipt mismatch');

    await sql`update reasoning.business_runs
      set privacy_erased_at = coalesce(privacy_erased_at, now()), purpose = 'privacy-erased',
          context_bundle_ref = null, context_refs = null,
          recording_account_id = null, recording_generation = null,
          recording_context_sha256 = null, recording_model_context_sha256 = null
      where universe_id = ${universeId}`.execute(trx);
    await sql`update reasoning.external_attempts
      set privacy_erased_at = coalesce(privacy_erased_at, now()), output = null,
          output_issues = null, quota_observation = null, dispatched_by = null,
          outcome_code = case when outcome_code in (${sql.join(PRIVACY_ACCOUNTING_CODES)})
            then outcome_code else null end,
          written_off_reason = case when written_off_reason is not null or state = 'written_off'
            then 'privacy-erased' else null end,
          written_off_by = case when written_off_by is not null or state = 'written_off'
            then 'privacy-erased' else null end,
          remote_id = case when remote_id ~ '^[A-Za-z0-9_.:-]{1,128}$' then remote_id else null end
      where universe_id = ${universeId}`.execute(trx);
    const requests = await trx
      .deleteFrom('reasoning.protected_requests')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    const attempts = await trx
      .deleteFrom('reasoning.external_attempts')
      .where('universe_id', '=', universeId)
      .where('state', 'not in', ['reserved', 'dispatched', 'unknown'])
      .executeTakeFirst();
    const runs = await trx
      .deleteFrom('reasoning.business_runs as run')
      .where('run.universe_id', '=', universeId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('reasoning.external_attempts as attempt')
              .select(sql<number>`1`.as('one'))
              .whereRef('attempt.universe_id', '=', 'run.universe_id')
              .whereRef('attempt.run_id', '=', 'run.id'),
          ),
        ),
      )
      .executeTakeFirst();
    const open = await trx
      .selectFrom('reasoning.external_attempts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('universe_id', '=', universeId)
      .executeTakeFirstOrThrow();
    return {
      module: 'reasoning',
      status: Number(open.n) > 0 ? 'pending' : 'completed',
      removed: Number(requests.numDeletedRows + attempts.numDeletedRows + runs.numDeletedRows),
    };
  },
};

/** Selective cleanup keeps marked minimal links until the exact accounting owner prunes them. */
reasoningErasure.clearExploration = {
  dispositions: {
    'reasoning.protected_requests': 'erase',
    'reasoning.external_attempts': 'redact_accounting',
    'reasoning.business_runs': 'redact_accounting',
    'store:minimax/request-copies': 'external_retention',
  },
  async erase(scope) {
    const trx = clearCoreTransactionOf(scope);
    const universeId = scope.binding.universeId;
    // Root is already held. Parent-before-child ordering also matches purge/settlement; return
    // counts, not private rows or an unbounded JS payload list. Timeouts roll back the erasure.
    await sql`with locked as materialized (
      select id from reasoning.business_runs where universe_id = ${universeId}
      order by id for update
    ) select count(*) from locked`.execute(trx);
    await sql`with locked as materialized (
      select id from reasoning.external_attempts where universe_id = ${universeId}
      order by id for update
    ) select count(*) from locked`.execute(trx);
    await sql`with locked as materialized (
      select receipt.attempt_id from reasoning.usage_receipts receipt
      where exists (select 1 from reasoning.external_attempts attempt
        where attempt.universe_id = ${universeId} and attempt.id = receipt.attempt_id)
      order by receipt.attempt_id for update
    ) select count(*) from locked`.execute(trx);

    // The root excludes dispatch CAS, and the locked current state/identity/receipt prove no
    // dispatch intent ever committed. Missing/inconsistent proof stays held and pending.
    const released = await sql<{ attempts: string; receipts: string }>`
      with stopped as (
        update reasoning.external_attempts attempt
        set state = 'not_sent', outcome_code = 'AUTHORITY_REFUSED', settled_at = now()
        where attempt.universe_id = ${universeId} and attempt.state = 'reserved'
          and attempt.dispatch_id is null and attempt.dispatched_at is null
          and exists (select 1 from reasoning.usage_receipts receipt
            where receipt.attempt_id = attempt.id and receipt.state = 'held'
              and (receipt.role_id, receipt.role_version, receipt.provider, receipt.model,
                   receipt.budget_window, receipt.reserved_tokens) is not distinct from
                  (attempt.role_id, attempt.role_version, attempt.provider, attempt.model,
                   attempt.budget_window, attempt.reserved_tokens))
        returning attempt.id
      ), refunded as (
        update reasoning.usage_receipts set state = 'released', settled_at = now()
        where state = 'held' and attempt_id in (select id from stopped)
        returning attempt_id
      ) select (select count(*) from stopped)::text as attempts,
               (select count(*) from refunded)::text as receipts`.execute(trx);
    if (released.rows[0]?.attempts !== released.rows[0]?.receipts)
      throw new Error('Reasoning privacy reservation receipt mismatch');

    await sql`update reasoning.business_runs
      set privacy_erased_at = coalesce(privacy_erased_at, now()), purpose = 'privacy-erased',
          context_bundle_ref = null, context_refs = null,
          recording_account_id = null, recording_generation = null,
          recording_context_sha256 = null, recording_model_context_sha256 = null
      where universe_id = ${universeId}`.execute(trx);
    await sql`update reasoning.external_attempts
      set privacy_erased_at = coalesce(privacy_erased_at, now()), output = null,
          output_issues = null, quota_observation = null, dispatched_by = null,
          outcome_code = case when outcome_code in (${sql.join(PRIVACY_ACCOUNTING_CODES)})
            then outcome_code else null end,
          written_off_reason = case when written_off_reason is not null or state = 'written_off'
            then 'privacy-erased' else null end,
          written_off_by = case when written_off_by is not null or state = 'written_off'
            then 'privacy-erased' else null end,
          remote_id = case when remote_id ~ '^[A-Za-z0-9_.:-]{1,128}$' then remote_id else null end
      where universe_id = ${universeId}`.execute(trx);
    const requests = await trx
      .deleteFrom('reasoning.protected_requests')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    await sql`delete from reasoning.business_runs r where universe_id=${universeId}
      and not exists(select 1 from reasoning.external_attempts a where a.universe_id=r.universe_id and a.run_id=r.id)`.execute(
      trx,
    );
    return {
      module: 'reasoning',
      status: 'completed',
      removed: Number(requests.numDeletedRows),
    };
  },
};

/** The privacy owner sees only bounded accounting identities, never request or result bytes. */
export const clearReasoning: ClearReasoning = {
  async capture(scope) {
    const trx = privacyTransactionOf(scope),
      universeId = scope.authority.universeId;
    await sql`with locked as materialized (select id from reasoning.business_runs
   where universe_id=${universeId} order by id for update) select count(*) from locked`.execute(trx);
    await sql`with locked as materialized (select id from reasoning.external_attempts
   where universe_id=${universeId} order by id for update) select count(*) from locked`.execute(trx);
    await sql`with locked as materialized (select r.attempt_id from reasoning.usage_receipts r
   where exists(select 1 from reasoning.external_attempts a where a.universe_id=${universeId} and a.id=r.attempt_id)
   order by r.attempt_id for update) select count(*) from locked`.execute(trx);
    // Check sizes in SQL before materializing text. 1000 * bounded tuple < 1 MiB.
    const guard = await sql<{ n: number; bad: boolean }>`select count(*)::int n, coalesce(bool_or(
   a.role_id is null or a.role_version is null or a.budget_window is null
   or octet_length(a.role_id) not between 1 and 128 or octet_length(a.role_version) not between 1 and 128
   or octet_length(a.provider) not between 1 and 128 or octet_length(a.model) not between 1 and 128
   or r.attempt_id is null or
   (a.role_id,a.role_version,a.provider,a.model,a.budget_window,a.reserved_tokens) is distinct from
   (r.role_id,r.role_version,r.provider,r.model,r.budget_window,r.reserved_tokens)),false) bad
   from reasoning.external_attempts a left join reasoning.usage_receipts r on r.attempt_id=a.id
   where a.universe_id=${universeId}`.execute(trx);
    if (!guard.rows[0] || guard.rows[0].n > 1000 || guard.rows[0].bad) throw new Error('CLEAR_ACCOUNTING_UNVERIFIED');
    const rows = await sql<ClearLiability>`select id as "attemptId",run_id as "runId",role_id as "roleId",
   role_version as "roleVersion",provider,model,budget_window::text as "budgetWindow",reserved_tokens as "reservedTokens"
   from reasoning.external_attempts where universe_id=${universeId} order by id limit 1001`.execute(trx);
    return rows.rows;
  },
  async verifyAndPrune(scope) {
    const trx = clearAccountingTransactionOf(scope);
    let pending = false,
      retained = false;
    // Exact captured set only; no query discovers fresh personal attempts or private bytes.
    for (const l of scope.liabilities) {
      await trx
        .selectFrom('reasoning.business_runs')
        .select('id')
        .where('universe_id', '=', scope.binding.universeId)
        .where('id', '=', l.runId)
        .forUpdate()
        .executeTakeFirst();
      const attempt = await trx
        .selectFrom('reasoning.external_attempts')
        .select([
          'id',
          'run_id',
          'state',
          'privacy_erased_at',
          'role_id',
          'role_version',
          'provider',
          'model',
          'reserved_tokens',
          sql<string>`budget_window::text`.as('budget_window'),
        ])
        .where('universe_id', '=', scope.binding.universeId)
        .where('id', '=', l.attemptId)
        .forUpdate()
        .executeTakeFirst();
      const receipt = await trx
        .selectFrom('reasoning.usage_receipts')
        .select([
          'role_id',
          'role_version',
          'provider',
          'model',
          'reserved_tokens',
          'state',
          sql<string>`budget_window::text`.as('budget_window'),
        ])
        .where('attempt_id', '=', l.attemptId)
        .forUpdate()
        .executeTakeFirst();
      const matches = (r: {
        role_id: string | null;
        role_version: string | null;
        provider: string;
        model: string;
        budget_window: string | null;
        reserved_tokens: number;
      }) =>
        r.role_id === l.roleId &&
        r.role_version === l.roleVersion &&
        r.provider === l.provider &&
        r.model === l.model &&
        String(r.budget_window) === l.budgetWindow &&
        r.reserved_tokens === l.reservedTokens;
      if (
        !receipt ||
        !matches(receipt) ||
        (attempt && (!matches(attempt) || attempt.run_id !== l.runId || !attempt.privacy_erased_at))
      )
        throw new Error('CLEAR_ACCOUNTING_UNVERIFIED');
      if (
        receipt.state === 'held' ||
        receipt.state === 'unknown' ||
        (attempt && ['reserved', 'dispatched', 'unknown'].includes(attempt.state))
      ) {
        pending = true;
        continue;
      }
      const day = await sql<{
        past: boolean;
      }>`select ${l.budgetWindow}::date < (now() at time zone 'UTC')::date as past`.execute(trx);
      if (attempt && !day.rows[0]?.past) retained = true;
      if (attempt && day.rows[0]?.past) {
        await trx
          .deleteFrom('reasoning.external_attempts')
          .where('universe_id', '=', scope.binding.universeId)
          .where('id', '=', l.attemptId)
          .execute();
        await sql`delete from reasoning.business_runs r where universe_id=${scope.binding.universeId} and id=${l.runId}
     and privacy_erased_at is not null and not exists(select 1 from reasoning.external_attempts a
      where a.universe_id=r.universe_id and a.run_id=r.id)`.execute(trx);
      }
    }
    return pending ? 'pending' : retained ? 'verified_retained' : 'verified';
  },
};
