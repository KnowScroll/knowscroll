import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { EXPORT_LIST_LIMIT, boundedSection, exportReading } from '../../../infrastructure/erasure/registry.js';
import { deleteClearJobPayloads, deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { suggestDraftQueue } from '../events.js';

/**
 * What the scenarios module keeps about a person (D-049). Both stores are keyed by account.
 * - **Drafts** are a member's private composer sessions: their words and the directions proposed for
 *   them. Selective Clear and every erasure delete them, and the queued job that would answer one.
 * - **Nodes** are the thread's shared exploration, a contribution like a message. Clear keeps them.
 *   Deleting an account keeps the branch and its Scroll for the others and removes the member's
 *   authorship and their words (`request_text`): the card then names nobody.
 */
export const scenariosErasure = declareErasure({
  module: 'scenarios',
  tables: [],
  accountTables: [
    { schema: 'scenarios', table: 'drafts', ownerColumn: 'requester_account_id' },
    { schema: 'scenarios', table: 'nodes', ownerColumn: 'started_by_account_id' },
  ],
  accountColumns: [
    { schema: 'scenarios', table: 'drafts', column: 'requester_account_id' },
    { schema: 'scenarios', table: 'drafts', column: 'requester_universe_id' },
    { schema: 'scenarios', table: 'nodes', column: 'started_by_account_id' },
  ],
  nonRowStores: [
    {
      name: `pgboss/${suggestDraftQueue.name}`,
      description: 'Queued, active, retained and dead-lettered draft IDs.',
    },
  ],
  async erase(scope) {
    const removed = await transactionOf(scope)
      .deleteFrom('scenarios.drafts')
      .where('requester_universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return {
      module: 'scenarios',
      status: 'completed',
      removed: Number(removed.numDeletedRows) + (await deleteJobPayloads(scope, [suggestDraftQueue.name])),
    };
  },
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const drafts = await trx
      .deleteFrom('scenarios.drafts')
      .where('requester_account_id', '=', scope.accountId)
      .executeTakeFirst();
    const nodes = await trx
      .updateTable('scenarios.nodes')
      .set({ started_by_account_id: null, request_text: null })
      .where('started_by_account_id', '=', scope.accountId)
      .executeTakeFirst();
    return {
      module: 'scenarios',
      status: 'completed',
      removed: Number(drafts.numDeletedRows) + Number(nodes.numUpdatedRows),
    };
  },
  clear: {
    defaultDisposition: 'erase',
    dispositions: { 'scenarios.nodes': 'preserve' },
    async erase(scope) {
      const removed = await clearCoreTransactionOf(scope)
        .deleteFrom('scenarios.drafts')
        .where('requester_universe_id', '=', scope.binding.universeId)
        .executeTakeFirst();
      return {
        module: 'scenarios',
        status: 'completed',
        removed: Number(removed.numDeletedRows) + (await deleteClearJobPayloads(scope, [suggestDraftQueue.name])),
      };
    },
  },
  /** The person's own requests, in their words, and what became of them. No IDs, no other person's request. */
  export: (declaration) =>
    exportReading(
      declaration,
      ['scenarios.drafts', 'scenarios.nodes'],
      'Queue jobs are delivery bookkeeping for the drafts listed.',
      async (scope, person) => {
        const trx = transactionOf(scope);
        const drafts = await sql<{ created_at: Date; kind: string; request_text: string; state: string }>`
          select created_at, kind, request_text, state from scenarios.drafts
          where requester_account_id = ${person.accountId}::uuid
          order by created_at desc, draft_id limit ${EXPORT_LIST_LIMIT + 1}`.execute(trx);
        const branches = await sql<{ created_at: Date; kind: string; request_text: string | null; status: string }>`
          select created_at, kind, request_text, status from scenarios.nodes
          where started_by_account_id = ${person.accountId}::uuid
          order by created_at desc, node_id limit ${EXPORT_LIST_LIMIT + 1}`.execute(trx);
        // A person who never used What if has no section: the file never names the module.
        if (drafts.rows.length === 0 && branches.rows.length === 0) return {};
        return {
          drafts: boundedSection(
            drafts.rows.map((row) => ({
              askedAt: row.created_at.toISOString(),
              kind: row.kind,
              words: row.request_text,
              state: row.state,
            })),
          ),
          branches: boundedSection(
            branches.rows.map((row) => ({
              startedAt: row.created_at.toISOString(),
              kind: row.kind,
              ...(row.request_text === null ? {} : { words: row.request_text }),
              state: row.status,
            })),
          ),
        };
      },
    ),
});
