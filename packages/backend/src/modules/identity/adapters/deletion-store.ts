import { sql, type Kysely } from 'kysely';
import type { EnqueueInTransaction, EnqueueJob } from '../../../infrastructure/jobs/index.js';
import { revokeAccountSockets } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { runInScope, transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { DeleteAccountPorts } from '../application/delete-account.js';
import { deleteAccountQueue } from '../events.js';
import type { AccountDeletionTx, PersonalAuthority } from '../public.js';
import { lockAddressIn } from './postgres-store.js';

/** How long a deletion waits before the recovery pass hands it back if its job never finished it. */
const FIRST_RECOVERY_MINUTES = 10;
/** How long accounting that still holds the universe, or a recovered hand-back, waits to try again. */
const RETRY_MINUTES = 15;
/** Statement bound of the deletion transaction: the erasers touch one person's rows, never the table. */
const DELETION_STATEMENT_TIMEOUT_MS = 60_000;

/**
 * Opens the deletion transaction of one operation: identity's address lock, then the deleting
 * universe root, then its account, then the operation row (the lock order the sign-in and fence
 * code documents). Gives `work` the capability the universe erasers need: a system scope over the
 * root, which `withPersonalScope` refuses because the status is `deleting`. `undefined` when the
 * operation is unknown or already completed.
 */
export function makeWithAccountDeletion(db: Kysely<Database>, options: { readonly lockTimeoutMs: number }) {
  return <T>(deletionId: string, work: (scope: AccountDeletionTx) => Promise<T>): Promise<T | undefined> =>
    withTransaction(db, 'identity.account-deletion', async (trx) => {
      await sql`select set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true),
        set_config('statement_timeout', ${`${DELETION_STATEMENT_TIMEOUT_MS}ms`}, true)`.execute(trx);
      const locator = await trx
        .selectFrom('identity.account_deletions')
        .select(['account_id', 'scope_id'])
        .where('id', '=', deletionId)
        .where('state', '=', 'pending')
        .executeTakeFirst();
      if (locator === undefined || locator.account_id === null || locator.scope_id === null) return undefined;
      const { account_id: accountId, scope_id: universeId } = locator;
      const address = await trx
        .selectFrom('identity.email_addresses')
        .select('address')
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (address !== undefined) await lockAddressIn(trx, address.address);
      const root = await trx
        .selectFrom('identity.universes')
        .select(['account_id', 'privacy_epoch', 'revision', 'status'])
        .where('id', '=', universeId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (root?.account_id !== accountId || root.status !== 'deleting') throw new Error('ACCOUNT_DELETION_BINDING');
      await trx.selectFrom('identity.accounts').select('id').where('id', '=', accountId).forUpdate().executeTakeFirst();
      const pending = await trx
        .selectFrom('identity.account_deletions')
        .select('id')
        .where('id', '=', deletionId)
        .where('state', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (pending === undefined) return undefined;
      const authority: PersonalAuthority = {
        universeId,
        privacyEpoch: root.privacy_epoch,
        actor: { kind: 'system', purpose: 'identity.delete-account' },
      };
      return runInScope(trx, authority, root.revision, (personal) =>
        work(
          Object.freeze({ operationId: deletionId, accountId, universeId, personal }) as unknown as AccountDeletionTx,
        ),
      );
    });
}

/**
 * The SQL behind account deletion. `fence` runs inside `withPersonalScope` after the own-account
 * gate: it is the only place that moves an account to `deleting`.
 */
export function deletionStore(deps: {
  readonly db: Kysely<Database>;
  readonly enqueueJob: EnqueueJob;
  readonly enqueueInTransaction: EnqueueInTransaction;
}): Pick<
  DeleteAccountPorts,
  'fence' | 'enqueue' | 'readReceipt' | 'requestRetry' | 'finish' | 'postpone' | 'markFailed' | 'requeueDue'
> {
  const { db } = deps;
  return {
    async fence(scope, receiptId) {
      const trx = transactionOf(scope);
      const { universeId } = scope.authority;
      const owner = await trx
        .selectFrom('identity.universes')
        .select('account_id')
        .where('id', '=', universeId)
        .executeTakeFirstOrThrow();
      const inserted = await trx
        .insertInto('identity.account_deletions')
        .values({
          id: receiptId,
          account_id: owner.account_id,
          scope_id: universeId,
          next_attempt_at: sql<Date>`now() + make_interval(mins => ${FIRST_RECOVERY_MINUTES})`,
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows === 0n) return 'receipt_in_use';
      await trx
        .updateTable('identity.universes')
        .set({ status: 'deleting', privacy_epoch: sql`privacy_epoch + 1`, revision: sql`revision + 1` })
        .where('id', '=', universeId)
        .execute();
      await trx
        .updateTable('identity.accounts')
        .set({ status: 'deleting' })
        .where('id', '=', owner.account_id)
        .execute();
      await trx.deleteFrom('identity.sessions').where('account_id', '=', owner.account_id).execute();
      await revokeAccountSockets(trx, owner.account_id);
      return 'fenced';
    },

    enqueue: (scope, deletionId) => deps.enqueueJob(scope, deleteAccountQueue, { v: 1, deletionId }),

    async readReceipt(receiptId) {
      const row = await db
        .selectFrom('identity.account_deletions')
        .select(['state', 'failure_code'])
        .where('id', '=', receiptId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (row.state === 'completed') return 'completed';
      return row.failure_code === 'temporarily_unavailable' ? 'needs_retry' : 'in_progress';
    },

    requestRetry: (receiptId) =>
      withTransaction(db, 'identity.retry-account-deletion', async (trx) => {
        const row = await trx
          .selectFrom('identity.account_deletions')
          .select('state')
          .where('id', '=', receiptId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return 'not_found';
        if (row.state === 'completed') return 'completed';
        await trx
          .updateTable('identity.account_deletions')
          .set({ failure_code: null, next_attempt_at: sql<Date>`now() + make_interval(mins => ${RETRY_MINUTES})` })
          .where('id', '=', receiptId)
          .execute();
        await deps.enqueueInTransaction(trx, deleteAccountQueue, { v: 1, deletionId: receiptId });
        return 'queued';
      }),

    async finish(scope) {
      const trx = transactionOf(scope.personal);
      // The operation sheds its links first (they reference the rows about to go), then becomes
      // the audit row: an id, two timestamps and a state.
      await trx
        .updateTable('identity.account_deletions')
        .set({
          state: 'completed',
          account_id: null,
          scope_id: null,
          completed_at: sql<Date>`now()`,
          failure_code: null,
        })
        .where('id', '=', scope.operationId)
        .execute();
      await trx.deleteFrom('identity.universes').where('id', '=', scope.universeId).execute();
      await trx.deleteFrom('identity.accounts').where('id', '=', scope.accountId).execute();
    },

    async postpone(scope) {
      await transactionOf(scope.personal)
        .updateTable('identity.account_deletions')
        .set({
          attempts: sql<number>`attempts + 1`,
          failure_code: 'waiting_for_accounting',
          next_attempt_at: sql<Date>`now() + make_interval(mins => ${RETRY_MINUTES})`,
        })
        .where('id', '=', scope.operationId)
        .execute();
    },

    async markFailed(deletionId) {
      await db
        .updateTable('identity.account_deletions')
        .set({ failure_code: 'temporarily_unavailable', attempts: sql<number>`attempts + 1` })
        .where('id', '=', deletionId)
        .where('state', '=', 'pending')
        .execute();
    },

    requeueDue: (limit) =>
      withTransaction(db, 'identity.recover-account-deletions', async (trx) => {
        const due = await trx
          .selectFrom('identity.account_deletions')
          .select('id')
          .where('state', '=', 'pending')
          .where('next_attempt_at', '<=', sql<Date>`now()`)
          .orderBy('next_attempt_at')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        for (const { id } of due) await deps.enqueueInTransaction(trx, deleteAccountQueue, { v: 1, deletionId: id });
        if (due.length > 0)
          await trx
            .updateTable('identity.account_deletions')
            .set({ next_attempt_at: sql<Date>`now() + make_interval(mins => ${RETRY_MINUTES})` })
            .where(
              'id',
              'in',
              due.map((row) => row.id),
            )
            .execute();
        return due.length;
      }),
  };
}
