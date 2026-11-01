import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { EXPORT_LIST_LIMIT, boundedSection, exportReading } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads, deleteClearJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { resolveSupplyQueue } from '../events.js';
import { answerQuickAnswerQueue } from '../quick-answer-events.js';

/**
 * Wipes the words a person typed from the orders made for their questions, before their requests (and so the link to
 * those orders) are deleted. The order stays, so its Scroll is never read as a public one: with no request left it is
 * open to nobody (D-218). This is the one write supply makes into Content's table: an order is the only place a person's
 * words leave the request, and nothing else knows which order is theirs.
 */
async function scrubQuestionOrders(trx: ReturnType<typeof transactionOf>, universeId: string): Promise<void> {
  await sql`update content.made_to_order_scrolls set brief = ''
    where mode = 'question' and asset_id in (
      select ask_asset_id from supply.requests where universe_id = ${universeId}::uuid and ask_asset_id is not null)`.execute(
    trx,
  );
}

/** Shared work contains public briefs only; erase private asks/waiters and every retained job ID. */
export const supplyErasure = declareErasure({
  module: 'supply',
  tables: [
    { schema: 'supply', table: 'requests', ownerColumn: 'universe_id' },
    // A Quick answer: the words the person asked and what the card shows, erased with them (D-253).
    { schema: 'supply', table: 'quick_answers', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [
    {
      name: `pgboss/${resolveSupplyQueue.name}`,
      description: 'Queued, active, retained and dead-lettered private request IDs.',
    },
    {
      name: `pgboss/${answerQuickAnswerQueue.name}`,
      description: 'Queued, active, retained and dead-lettered Quick answer IDs.',
    },
  ],
  async erase(scope) {
    await scrubQuestionOrders(transactionOf(scope), scope.authority.universeId);
    const removed = await transactionOf(scope)
      .deleteFrom('supply.requests')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    const answers = await transactionOf(scope)
      .deleteFrom('supply.quick_answers')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return {
      module: 'supply',
      status: 'completed',
      removed:
        Number(removed.numDeletedRows) +
        Number(answers.numDeletedRows) +
        (await deleteJobPayloads(scope, [resolveSupplyQueue.name, answerQuickAnswerQueue.name])),
    };
  },
  clear: {
    defaultDisposition: 'erase',
    async erase(scope) {
      await scrubQuestionOrders(clearCoreTransactionOf(scope), scope.binding.universeId);
      const removed = await clearCoreTransactionOf(scope)
        .deleteFrom('supply.requests')
        .where('universe_id', '=', scope.binding.universeId)
        .executeTakeFirst();
      const answers = await clearCoreTransactionOf(scope)
        .deleteFrom('supply.quick_answers')
        .where('universe_id', '=', scope.binding.universeId)
        .executeTakeFirst();
      return {
        module: 'supply',
        status: 'completed',
        removed:
          Number(removed.numDeletedRows) +
          Number(answers.numDeletedRows) +
          (await deleteClearJobPayloads(scope, [resolveSupplyQueue.name, answerQuickAnswerQueue.name])),
      };
    },
  },
  /** What the person asked for, in their own words and the state it reached; no IDs, briefs or shared work. */
  export: (declaration) =>
    exportReading(
      declaration,
      ['supply.requests', 'supply.quick_answers'],
      'Queue jobs are delivery bookkeeping for the requests and Quick answers listed.',
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
            coalesce(command #>> '{intent,subject,text}', command #>> '{intent,question}') as text,
            command #>> '{intent,subject,topicId}' as topic,
            coalesce(command #>> '{intent,format}', command #>> '{intent,to}',
              case when command #>> '{intent,kind}' = 'ask' then 'scroll' end) as format
          from supply.requests
          where universe_id = ${scope.authority.universeId}::uuid and origin = 'person'
            and command #>> '{intent,kind}' is not null
          order by created_at desc, id
          limit ${EXPORT_LIST_LIMIT + 1}`.execute(transactionOf(scope));
        const answers = await sql<{ created_at: Date; question: string; answer: string }>`
          select created_at, shown_question as question, answer
          from supply.quick_answers
          where universe_id = ${scope.authority.universeId}::uuid and state = 'answered' and expires_at > now()
          order by created_at desc, id
          limit ${EXPORT_LIST_LIMIT + 1}`.execute(transactionOf(scope));
        return {
          quickAnswers: boundedSection(
            answers.rows.map((row) => ({
              askedAt: row.created_at.toISOString(),
              question: row.question,
              answer: row.answer,
            })),
          ),
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
