import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { EXPORT_LIST_LIMIT, boundedSection, exportReading } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads, deleteClearJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { resolveSupplyQueue } from '../events.js';
/** Shared work contains public briefs only; erase private asks/waiters and every retained job ID. */
export const supplyErasure = declareErasure({
  module: 'supply',
  tables: [{ schema: 'supply', table: 'requests', ownerColumn: 'universe_id' }],
  nonRowStores: [
    {
      name: `pgboss/${resolveSupplyQueue.name}`,
      description: 'Queued, active, retained and dead-lettered private request IDs.',
    },
  ],
  async erase(scope) {
    const removed = await transactionOf(scope)
      .deleteFrom('supply.requests')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return {
      module: 'supply',
      status: 'completed',
      removed: Number(removed.numDeletedRows) + (await deleteJobPayloads(scope, [resolveSupplyQueue.name])),
    };
  },
  clear: {
    defaultDisposition: 'erase',
    async erase(scope) {
      const removed = await clearCoreTransactionOf(scope)
        .deleteFrom('supply.requests')
        .where('universe_id', '=', scope.binding.universeId)
        .executeTakeFirst();
      return {
        module: 'supply',
        status: 'completed',
        removed: Number(removed.numDeletedRows) + (await deleteClearJobPayloads(scope, [resolveSupplyQueue.name])),
      };
    },
  },
  /** What the person asked for, in their own words and the state it reached; no IDs, briefs or shared work. */
  export: (declaration) =>
    exportReading(
      declaration,
      ['supply.requests'],
      'Queue jobs are delivery bookkeeping for the requests listed.',
      async (scope) => {
        const rows = await sql<{
          created_at: Date;
          state: string;
          kind: string;
          text: string | null;
          topic: string | null;
          format: string | null;
        }>`
          select created_at, state,
            command #>> '{intent,kind}' as kind,
            command #>> '{intent,subject,text}' as text,
            command #>> '{intent,subject,topicId}' as topic,
            coalesce(command #>> '{intent,format}', command #>> '{intent,to}') as format
          from supply.requests
          where universe_id = ${scope.authority.universeId}::uuid and origin = 'person'
            and command #>> '{intent,kind}' is not null
          order by created_at desc, id
          limit ${EXPORT_LIST_LIMIT + 1}`.execute(transactionOf(scope));
        return {
          requests: boundedSection(
            rows.rows.map((row) => ({
              askedAt: row.created_at.toISOString(),
              kind: row.kind,
              ...(row.text === null ? {} : { text: row.text }),
              ...(row.topic === null ? {} : { topic: row.topic }),
              format: row.format,
              state: row.state,
            })),
          ),
        };
      },
    ),
});
