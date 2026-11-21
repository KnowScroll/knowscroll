import { sql, type Kysely, type Transaction } from 'kysely';
import {
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
} from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';

/**
 * Retirement (D-435). A v1 or v2 revision of an asset whose current revision is a `scroll-document.v3`, and which is earlier than it, is retired: it
 * is served to no one, whoever pinned it. An earlier document v3 revision is not: it is a correction's predecessor in the same format, and stays
 * readable for a person who opened it before the correction, as D-129 has it. The rule is derived from rows that already exist (the asset's current revision pointer and that revision's schema), so
 * there is no table and no flag to keep in step: releasing a v3 retires the revisions before it in the same statement that moves the pointer, and no
 * later write can bring one back. A revision a review gate still holds is not current, so it retires nothing.
 */

/**
 * SQL: the revision is not retired. True for a current revision, for an earlier document v3 revision, for every revision of an asset whose current
 * revision is a v1 or a v2 (a v1 still stands in for a client that cannot read the v2, D-129) and for one whose asset has no current revision row. A read that takes an exact asset
 * and revision from its caller applies it next to `notUnderReview`.
 *
 * @param assetColumn the query's column holding the asset id, such as `r.asset_id`
 * @param revisionColumn the query's column holding the revision, such as `r.revision`
 */
export const notRetired = (assetColumn: string, revisionColumn: string) =>
  sql`not exists (select 1 from content.assets head
    join content.asset_revisions head_revision on head_revision.asset_id = head.id and head_revision.revision = head.revision
    join content.asset_revisions own on own.asset_id = head.id and own.revision = ${sql.ref(revisionColumn)}
    where head.id = ${sql.ref(assetColumn)} and head.revision > ${sql.ref(revisionColumn)}
      and head_revision.document_version = ${SCROLL_DOCUMENT_V3_SCHEMA_VERSION}::text
      and own.document_version in (${SCROLL_DOCUMENT_SCHEMA_VERSION}::text, ${SCROLL_DOCUMENT_V2_SCHEMA_VERSION}::text))`;

/**
 * Whether a revision is retired, for a read that has no query of its own to put `notRetired` in. A revision that does not exist is not retired
 * (the caller finds it absent in its own way).
 */
export async function isRetiredRevision(
  db: Kysely<Database> | Transaction<Database>,
  assetId: string,
  revision: number,
): Promise<boolean> {
  const { rows } = await sql<{ retired: boolean }>`select not (${notRetired('r.asset_id', 'r.revision')}) as retired
    from content.asset_revisions r
    where r.asset_id = ${assetId}::uuid and r.revision = ${revision}::integer`.execute(db);
  return rows[0]?.retired === true;
}
