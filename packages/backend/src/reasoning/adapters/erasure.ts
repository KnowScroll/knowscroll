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
            where receipt.attempt_id = attempt.id and receipt.state = 'held')
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
          context_bundle_ref = null, context_refs = null
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
