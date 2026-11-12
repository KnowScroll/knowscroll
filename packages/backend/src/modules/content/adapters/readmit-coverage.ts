import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readmitRecipeCoverage } from '../application/readmit-recipe-coverage.js';
import { coverageHeadPorts } from './coverage-store.js';
import { makeAdmissionStore } from './postgres-store.js';
import { recipeBookOf } from './stored-recipes.js';

/**
 * The operator's `content readmit-coverage`: decide coverage again for every published generated
 * Scroll revision and every Reel made from an approved script, from the recipe book as it is now: the library plan and the
 * stored recipes. See `readmitRecipeCoverage`.
 */
export function readmitCoverageUseCase(db: Kysely<Database>) {
  return async (options: { readonly dryRun: boolean }) => {
    const recipes = await recipeBookOf(db).all();
    const byKey = new Map(recipes.map((recipe) => [recipe.key, recipe]));
    return readmitRecipeCoverage(
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
        async listReelRevisions() {
          // Only a Reel whose provenance carries a recipe key has a script to decide coverage from; the Reels imported
          // before scripts carried claims have none and stay unmapped.
          const rows = await sql<{ asset_id: string; revision: number; recipe: string }>`
            select r.asset_id, r.revision, p.provenance ->> 'recipe' as recipe
            from content.asset_revisions r join content.assets a on a.id = r.asset_id
              join content.asset_provenance p on p.asset_id = r.asset_id and p.revision = r.revision
            where a.kind = 'reel' and r.provenance_kind = 'cutroom_import' and p.provenance ->> 'recipe' is not null
            order by r.asset_id, r.revision`.execute(db);
          return rows.rows.map((row) => ({ assetId: row.asset_id, assetRevision: row.revision, recipe: row.recipe }));
        },
      },
      recipes,
      options,
      (key) => byKey.get(key),
    );
  };
}
