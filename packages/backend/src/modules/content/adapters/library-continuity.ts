import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  LIBRARY_CONTINUITY_AUTHORITY,
  planRelated,
  planSeries,
  type AdmittedScrolls,
  type ContinuityBatch,
  type StoredContinuity,
} from '../application/plan-library-continuity.js';
import type { ContinuityLink } from '../domain/discovery.js';
import { LIBRARY_RELATED, LIBRARY_SERIES } from '../domain/library/continuity.js';
import { RECIPES, RECIPE_KEYS, type RecipeKey } from '../domain/library/index.js';
import { admitContinuity } from './continuity-admission.js';
import { admissionTransaction, makeAdmissionStore } from './postgres-store.js';

/** A name-based (version 5 style) UUID of the content, so equal links have equal ids. */
function deriveLinkId(content: string): string {
  const hex = createHash('sha256').update(content).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** What `content admit-continuity` did, or in a dry run would do. */
export interface LibraryContinuitySummary {
  readonly dryRun: boolean;
  readonly seriesRevisionsAdmitted: number;
  readonly seriesUnchanged: number;
  readonly seriesSkipped: readonly { readonly seriesId: string; readonly unpublished: readonly RecipeKey[] }[];
  readonly linksAdmitted: number;
  readonly linksUnchanged: number;
  readonly relatedSkipped: readonly {
    readonly from: RecipeKey;
    readonly to: RecipeKey;
    readonly unpublished: RecipeKey[];
  }[];
}

interface LinkRow {
  id: string;
  revision: number;
  source_asset_id: string;
  source_asset_revision: number;
  target_asset_id: string;
  target_asset_revision: number;
  direction: ContinuityLink['direction'];
  relation: ContinuityLink['relation'];
  strength: number;
  authority_reference: string;
}

/** The Scroll revision admitted now for each recipe whose asset is an admitted Scroll. */
async function readAdmittedScrolls(trx: Transaction<Database>): Promise<AdmittedScrolls> {
  const assetIds = RECIPE_KEYS.map((key) => RECIPES[key].assetId);
  const rows = await trx
    .selectFrom('content.assets')
    .select(['id', 'revision'])
    .where('id', 'in', assetIds)
    .where('kind', '=', 'scroll')
    .where('status', '=', 'admitted')
    .execute();
  const admitted = new Map<RecipeKey, { assetId: string; assetRevision: number }>();
  for (const key of RECIPE_KEYS) {
    const row = rows.find((candidate) => candidate.id === RECIPES[key].assetId);
    if (row !== undefined) admitted.set(key, { assetId: row.id, assetRevision: row.revision });
  }
  return admitted;
}

/** The latest stored revision of each declared series and the active links out of declared recipes. */
async function readStoredContinuity(trx: Transaction<Database>): Promise<StoredContinuity> {
  const seriesIds = LIBRARY_SERIES.map((series) => series.id);
  const unitRows = (
    await sql<{ series_id: string; series_revision: number; part: number; asset_id: string; asset_revision: number }>`
      select series_id, series_revision, part, asset_id, asset_revision from content.series_units
      where series_id in (${sql.join(seriesIds)}) order by series_id, series_revision, part`.execute(trx)
  ).rows;
  const series = new Map<
    string,
    { seriesRevision: number; units: { assetId: string; assetRevision: number; part: number }[] }
  >();
  for (const row of unitRows) {
    const latest = series.get(row.series_id);
    const unit = { assetId: row.asset_id, assetRevision: row.asset_revision, part: row.part };
    if (latest !== undefined && latest.seriesRevision === row.series_revision) latest.units.push(unit);
    else series.set(row.series_id, { seriesRevision: row.series_revision, units: [unit] });
  }
  const assetIds = RECIPE_KEYS.map((key) => RECIPES[key].assetId);
  const linkRows = (
    await sql<LinkRow>`
      select id, revision, source_asset_id, source_asset_revision, target_asset_id, target_asset_revision,
             direction, relation, strength, authority_reference
      from content.continuity_links where active and source_asset_id in (${sql.join(assetIds)})`.execute(trx)
  ).rows;
  return {
    series,
    activeLinks: linkRows.map((row) => ({
      linkId: row.id,
      revision: row.revision,
      source: { assetId: row.source_asset_id, assetRevision: row.source_asset_revision },
      target: { assetId: row.target_asset_id, assetRevision: row.target_asset_revision },
      direction: row.direction,
      relation: row.relation,
      strength: row.strength,
      authorityReference: row.authority_reference,
    })),
  };
}

/**
 * The operator's `content admit-continuity`: admits the library plan's series and related moves
 * (`domain/library/continuity.ts`) through `admitContinuity`.
 *
 * Each recipe key resolves to the Scroll revision admitted now. A series is one transaction (its
 * manifest and its previous/next links); all related moves are one more. A series with a part not
 * yet published, and a related move with an unpublished end, are skipped and listed. Idempotent: what
 * the store holds exactly is left alone, so a re-run admits nothing; a changed declaration, or a
 * Scroll republished as a new revision, gets a new series revision and replacement links (new id,
 * next link revision) and the old rows stay as inactive history. With `dryRun` nothing is written.
 * Shared content only: no personal root, no model, no network.
 */
export function admitLibraryContinuityUseCase(db: Kysely<Database>) {
  const store = makeAdmissionStore(db);
  /** Reads, plans and (unless dry) admits one batch in one admission transaction. */
  const run = <T extends ContinuityBatch>(
    dryRun: boolean,
    plan: (admitted: AdmittedScrolls, stored: StoredContinuity) => T,
  ): Promise<T> =>
    store.inAdmission(async (tx) => {
      const trx = admissionTransaction(tx);
      const planned = plan(await readAdmittedScrolls(trx), await readStoredContinuity(trx));
      const { series, links } = planned.admission;
      if (!dryRun && (series.length > 0 || links.length > 0))
        await admitContinuity(tx, { authorityReference: LIBRARY_CONTINUITY_AUTHORITY, series, links });
      return planned;
    });

  return async (options: { readonly dryRun: boolean }): Promise<LibraryContinuitySummary> => {
    let seriesRevisionsAdmitted = 0;
    let seriesUnchanged = 0;
    let linksAdmitted = 0;
    let linksUnchanged = 0;
    const seriesSkipped: LibraryContinuitySummary['seriesSkipped'][number][] = [];
    for (const series of LIBRARY_SERIES) {
      const result = await run(options.dryRun, (admitted, stored) =>
        planSeries(series, admitted, stored, deriveLinkId),
      );
      if (result.unpublished.length > 0) {
        seriesSkipped.push({ seriesId: result.seriesId, unpublished: result.unpublished });
        continue;
      }
      seriesRevisionsAdmitted += result.admission.series.length;
      if (result.admission.series.length === 0 && result.admission.links.length === 0) seriesUnchanged++;
      linksAdmitted += result.admission.links.length;
      linksUnchanged += result.unchangedLinks;
    }
    const related = await run(options.dryRun, (admitted, stored) =>
      planRelated(LIBRARY_RELATED, admitted, stored, deriveLinkId),
    );
    linksAdmitted += related.admission.links.length;
    linksUnchanged += related.unchangedLinks;
    return {
      dryRun: options.dryRun,
      seriesRevisionsAdmitted,
      seriesUnchanged,
      seriesSkipped,
      linksAdmitted,
      linksUnchanged,
      relatedSkipped: related.skipped,
    };
  };
}
