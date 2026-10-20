import { sql } from 'kysely';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
const tables = ['contributions', 'supports', 'topics', 'state'] as const;
export const personalContextErasure: ModuleErasure = {
  module: 'personal-context',
  tables: tables.map((table) => ({ schema: 'personal_context', table, ownerColumn: 'universe_id' })),
  nonRowStores: [],
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const result =
        await sql`delete from ${sql.table(`personal_context.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    return { module: 'personal-context', status: 'completed', removed };
  },
};
