import { sql, type Transaction } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { JOB_SCHEMA, deadLetterQueueName } from '../../../infrastructure/jobs/queues.js';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import type { ExportPerson } from '../../../infrastructure/erasure/registry.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { PersonalScopeTx } from '../public.js';
import { buildDataExportQueue, clearExplorationQueue, deleteAccountQueue } from '../events.js';

/**
 * Identity's erasure declaration (blueprint §5). Identity's personal records are keyed by
 * account, not universe: the address, the sign-in links (which hold an address even before any
 * account exists), the sessions, the Clear and recording receipts, the operator audit link, the
 * person's exports and the deletion operation itself.
 *
 * Clearing or resetting a universe leaves sign-in working, so the account-lifetime records
 * survive; `erase` removes only the exploration lifecycle witness. Clear also removes the
 * person's export files: an export is a copy of the history Clear exists to remove.
 *
 * Account deletion (`eraseAccount`, after every module's `erase`) removes the account-keyed rows
 * and the queue payloads that name the account. The personal roots (`identity.accounts`,
 * `identity.universes`) and the deletion operation row are the lifecycle's own: the use case turns
 * the operation into an audit row with no personal data and deletes the roots last. The operator
 * audit keeps its row with `account_id` set to null.
 *
 * Outside our database: every sign-in mail AgentMail sent stays in the `knowscroll@agentmail.to`
 * inbox's sent items under AgentMail's own retention. We keep no message ID to find it by, so no
 * eraser of ours reaches it; the privacy copy must say so rather than promise its removal.
 */
export const identityErasure = declareErasure({
  module: 'identity',
  tables: [{ schema: 'identity', table: 'recording_lifecycle_witnesses', ownerColumn: 'universe_id' }],
  accountTables: [
    { schema: 'identity', table: 'recording_lifecycle_witnesses', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'recording_commands', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'email_addresses', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'sign_in_links', ownerColumn: 'address' },
    { schema: 'identity', table: 'sessions', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'clear_operations', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'clear_liabilities', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'data_exports', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'account_deletions', ownerColumn: 'account_id' },
  ],
  // The operator audit (ops.operator_sign_ins, review m9) outlives clearing a universe; account
  // deletion keeps each row as a tombstone (account_id set to null).
  accountColumns: [{ schema: 'ops', table: 'operator_sign_ins', column: 'account_id' }],
  nonRowStores: [
    {
      name: 'pgboss/identity.recover-clear-operations',
      description:
        'Fixed global version-only cron and finite operation-ID cursor continuations; bounded queue/terminal/dead-letter retention, no per-account effects or second outbox.',
    },
    {
      name: 'pgboss/identity.clear-exploration',
      description:
        'Account-owned operation delivery IDs only; bounded queue/terminal/dead-letter retention, preserved by selective Clear.',
    },
    {
      name: `pgboss/${buildDataExportQueue.name}`,
      description: 'Export IDs only, in all states. Removed with the export by selective Clear and account deletion.',
    },
    {
      name: `pgboss/${deleteAccountQueue.name}`,
      description:
        'The deletion operation ID only. The operation row loses its account link when the work completes, so retained jobs name no one.',
    },
    {
      name: 'agentmail/sent-sign-in-mail',
      description:
        "Copies of sign-in mail (address and an expired link) in AgentMail's sent items; provider retention, not erased by us",
    },
  ],
  async erase(scope) {
    const r =
      await sql`delete from identity.recording_lifecycle_witnesses where universe_id=${scope.authority.universeId}::uuid`.execute(
        transactionOf(scope),
      );
    return { module: 'identity', status: 'completed', removed: Number(r.numAffectedRows ?? 0) };
  },
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const { accountId } = scope;
    let removed = await deleteExportsOf(trx, accountId);
    removed += await deleteJobsNaming(trx, [clearExplorationQueue.name], 'accountId', [accountId]);
    const links = await sql`delete from identity.sign_in_links
      where consumed_account_id = ${accountId}::uuid
         or address in (select address from identity.email_addresses where account_id = ${accountId}::uuid)`.execute(
      trx,
    );
    removed += Number(links.numAffectedRows ?? 0);
    // Children before parents: liabilities and witnesses name a Clear operation.
    for (const table of [
      'sessions',
      'clear_liabilities',
      'recording_lifecycle_witnesses',
      'clear_operations',
      'recording_commands',
      'email_addresses',
    ] as const) {
      const result = await trx.deleteFrom(`identity.${table}`).where('account_id', '=', accountId).executeTakeFirst();
      removed += Number(result.numDeletedRows);
    }
    await trx
      .updateTable('ops.operator_sign_ins')
      .set({ account_id: null })
      .where('account_id', '=', accountId)
      .execute();
    return { module: 'identity', status: 'completed', removed };
  },
  clear: {
    defaultDisposition: 'preserve',
    dispositions: {
      'identity.recording_lifecycle_witnesses': 'erase',
      'identity.data_exports': 'erase',
      [`store:pgboss/${buildDataExportQueue.name}`]: 'erase',
      'store:agentmail/sent-sign-in-mail': 'external_retention',
    },
    async erase(scope) {
      const trx = clearCoreTransactionOf(scope);
      const witnesses =
        await sql`delete from identity.recording_lifecycle_witnesses where universe_id=${scope.binding.universeId}::uuid`.execute(
          trx,
        );
      const exports = await deleteExportsOf(trx, scope.binding.accountId);
      return { module: 'identity', status: 'completed', removed: Number(witnesses.numAffectedRows ?? 0) + exports };
    },
  },
  export: () => ({
    covers: ['identity.email_addresses', 'identity.sessions', 'identity.recording_lifecycle_witnesses'],
    omits: {
      'identity.recording_commands': 'Receipts of Pause and Resume; the current setting is in the file.',
      'identity.sign_in_links': 'One-time sign-in credentials and their hashes.',
      'identity.clear_operations': 'Bookkeeping of Clear requests.',
      'identity.clear_liabilities': 'Financial accounting identities of unfinished model work.',
      'identity.data_exports': 'The export files themselves.',
      'identity.account_deletions': 'Bookkeeping of a deletion request; none exists while the account is active.',
      'ops.operator_sign_ins': 'Operator audit of test sign-in links; holds no personal content.',
      'store:pgboss/identity.recover-clear-operations': 'Global maintenance cursor, no personal data.',
      'store:pgboss/identity.clear-exploration': 'Delivery bookkeeping of Clear.',
      [`store:pgboss/${buildDataExportQueue.name}`]: 'Delivery bookkeeping of exports.',
      [`store:pgboss/${deleteAccountQueue.name}`]: 'Delivery bookkeeping of deletion.',
      'store:agentmail/sent-sign-in-mail': 'Held by the mail provider, not by us.',
    },
    async read(scope, person) {
      return { account: await readAccountSection(scope, person) };
    },
  }),
});

/** The person's own address, setting and signed-in devices. Never a token, hash or session id. */
async function readAccountSection(scope: PersonalScopeTx, person: ExportPerson) {
  const trx = transactionOf(scope);
  const address = await trx
    .selectFrom('identity.email_addresses')
    .select(['address', 'created_at'])
    .where('account_id', '=', person.accountId)
    .executeTakeFirst();
  const root = await trx
    .selectFrom('identity.universes')
    .select('recording_on')
    .where('id', '=', scope.authority.universeId)
    .executeTakeFirst();
  const sessions = await trx
    .selectFrom('identity.sessions')
    .select(['client', 'device_label', 'created_at', 'last_used_at'])
    .where('account_id', '=', person.accountId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute();
  return {
    email: address?.address ?? null,
    accountCreatedAt: address?.created_at.toISOString() ?? null,
    recordingOn: root?.recording_on ?? null,
    signedInDevices: sessions.map((session) => ({
      device: session.device_label ?? (session.client === 'native' ? 'KnowScroll app' : 'Web browser'),
      signedInAt: session.created_at.toISOString(),
      lastUsedAt: (session.last_used_at ?? session.created_at).toISOString(),
    })),
  };
}

/** Removes the jobs of `queues` (and their dead letters) whose payload names one of `ids`. */
async function deleteJobsNaming(
  trx: Transaction<Database>,
  queues: readonly string[],
  field: 'accountId' | 'exportId',
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const names = queues.flatMap((queue) => [queue, deadLetterQueueName(queue)]);
  const result = await sql`delete from ${sql.table(`${JOB_SCHEMA}.job`)}
    where name = any(${names}::text[]) and data ->> ${field} = any(${ids}::text[])`.execute(trx);
  return Number(result.numAffectedRows ?? 0);
}

/** Deletes every export of the account with the queue jobs that name them. */
async function deleteExportsOf(trx: Transaction<Database>, accountId: string): Promise<number> {
  const exports = await trx
    .selectFrom('identity.data_exports')
    .select('id')
    .where('account_id', '=', accountId)
    .execute();
  const jobs = await deleteJobsNaming(
    trx,
    [buildDataExportQueue.name],
    'exportId',
    exports.map((row) => row.id),
  );
  const result = await trx.deleteFrom('identity.data_exports').where('account_id', '=', accountId).executeTakeFirst();
  return jobs + Number(result.numDeletedRows);
}
