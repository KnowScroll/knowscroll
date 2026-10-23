import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readmitRecipeCoverage } from '../application/readmit-recipe-coverage.js';
import { RECIPE_KEYS, RECIPES } from '../domain/library/index.js';
import { coverageHeadPorts } from './coverage-store.js';
import { makeAdmissionStore } from './postgres-store.js';

/**
 * The operator's `content readmit-coverage`: decide coverage again for every published generated
 * Scroll revision, from the library plan as it is now. See `readmitRecipeCoverage`.
 */
export function readmitCoverageUseCase(db: Kysely<Database>) {
  return (options: { readonly dryRun: boolean }) =>
    readmitRecipeCoverage(
      {
        coverage: coverageHeadPorts,
        inAdmission: makeAdmissionStore(db).inAdmission,
        async listGeneratedRevisions() {
          const rows = await sql<{ asset_id: string; revision: number }>`
            select r.asset_id, r.revision
            from content.asset_revisions r join content.assets a on a.id = r.asset_id
            where a.kind = 'scroll' and r.provenance_kind = 'generated'
            order by r.asset_id, r.revision`.execute(db);
          return rows.rows.map((row) => ({ assetId: row.asset_id, assetRevision: row.revision }));
        },
      },
      RECIPE_KEYS.map((key) => RECIPES[key]),
      options,
    );
}
