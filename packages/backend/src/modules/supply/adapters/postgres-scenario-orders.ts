import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ScenarioOrderStore } from '../application/scenario-orders.js';

/** Quartermaster's ledger of scenario orders (`supply.scenario_orders`): ID, thread and time, nothing personal. */
export const scenarioOrderStore: ScenarioOrderStore = {
  async lockCommissioning(scope) {
    await sql`select pg_advisory_xact_lock(hashtextextended('supply.commissioning', 0))`.execute(transactionOf(scope));
  },
  async exists(scope, orderId) {
    const row = await transactionOf(scope)
      .selectFrom('supply.scenario_orders')
      .select('order_id')
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    return row !== undefined;
  },
  async countSince(scope, since) {
    const row = await transactionOf(scope)
      .selectFrom('supply.scenario_orders')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
  async countForThread(scope, threadId) {
    const row = await transactionOf(scope)
      .selectFrom('supply.scenario_orders')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('thread_id', '=', threadId)
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
