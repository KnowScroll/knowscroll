import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PlannedDemandLedger } from '../application/ports.js';

/**
 * Quartermaster's counters of what became of the Planner's missing-supply opportunities
 * (`supply.planned_demand_outcomes`): a UTC day, an outcome code, a reason code and a count. No person, no topic and no
 * words, so it survives erasure like the other ledgers.
 *
 * The rows are shared by every person's plan, so they are locked last and in the order the caller sorted them
 * (outcome, then reason): no two transactions wait on each other's counters in opposite orders.
 */
export const plannedDemandLedger: PlannedDemandLedger = {
  async add(scope, when, counts) {
    const day = when.toISOString().slice(0, 10);
    for (const count of counts)
      await sql`insert into supply.planned_demand_outcomes (day, outcome, reason, total)
        values (${day}::date, ${count.outcome}, ${count.reason}, ${count.total})
        on conflict (day, outcome, reason)
        do update set total = supply.planned_demand_outcomes.total + excluded.total`.execute(transactionOf(scope));
  },
};
