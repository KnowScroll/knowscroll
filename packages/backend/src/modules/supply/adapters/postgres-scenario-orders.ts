import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ScenarioOrderStore } from '../application/scenario-orders.js';

/** Quartermaster's ledger of scenario orders (`supply.scenario_orders`): ID, thread and time, nothing personal. */
export const scenarioOrderStore: ScenarioOrderStore = {
  async lockCommissioning(scope) {
    await sql`select pg_advisory_xact_lock(hashtextextended('supply.commissioning', 0))`.execute(transactionOf(scope));
  },
  async countSince(scope, since) {
    const row = await transactionOf(scope)
      .selectFrom('supply.scenario_orders')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
  async countForThreadSince(scope, threadId, since) {
    const row = await transactionOf(scope)
      .selectFrom('supply.scenario_orders')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('thread_id', '=', threadId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
  async insert(scope, order) {
    await transactionOf(scope)
      .insertInto('supply.scenario_orders')
      .values({ order_id: order.orderId, thread_id: order.threadId })
      .execute();
  },
};
