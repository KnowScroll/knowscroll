import { sql } from 'kysely';

/**
 * SQL: the revision was not held or rejected by the review gate (D-138). It holds for every revision
 * that never went through the gate and for one an operator released. A read that takes an exact asset
 * and revision from its caller applies it, so naming a held revision reaches nothing. Reads that
 * follow the asset's current revision do not need it: the gate never advances that pointer to a
 * revision it holds.
 *
 * @param assetColumn the query's column holding the asset id, such as `r.asset_id`
 * @param revisionColumn the query's column holding the revision, such as `r.revision`
 */
export const notUnderReview = (assetColumn: string, revisionColumn: string) =>
  sql`not exists (select 1 from content.revision_reviews gate
    where gate.asset_id = ${sql.ref(assetColumn)} and gate.revision = ${sql.ref(revisionColumn)} and gate.state <> 'released')`;
