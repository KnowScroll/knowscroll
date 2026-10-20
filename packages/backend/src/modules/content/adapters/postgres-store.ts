import { parseDocument } from '@knowscroll/scroll-model';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { readingFactsOf } from './scroll-compiler.js';
import type { AssetKind } from '../domain/provenance.js';
import { ReadingFactsUnavailableError, type ReadingFacts } from '../domain/reading-facts.js';
import { ReadingFactsSchema } from './reading-facts-schema.js';
import type { AdmissionTx, ImportEditorialScrollPorts, LockedAsset } from '../application/ports.js';
import type { AssetForAction, OpenableAsset } from '../public.js';

/**
 * Reads one asset inside the caller's personal transaction (no lock: assets are shared and
 * withdrawal does not need to wait for personal commands). Returns `undefined` when missing.
 */
export async function findAssetForAction(scope: PersonalScopeTx, assetId: string): Promise<AssetForAction | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('content.assets')
    .select(['revision', 'status'])
    .where('id', '=', assetId)
    .executeTakeFirst();
  return row === undefined ? undefined : { revision: row.revision, admitted: row.status === 'admitted' };
}

/**
 * Reads the asset's current revision for opening it: its kind, the current revision number and
 * the integrity hash of that revision's stored document (when one exists). One statement, no lock.
 */
export async function findOpenableAsset(scope: PersonalScopeTx, assetId: string): Promise<OpenableAsset | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('content.assets as asset')
    .leftJoin('content.asset_revisions as revision', (join) =>
      join.onRef('revision.asset_id', '=', 'asset.id').onRef('revision.revision', '=', 'asset.revision'),
    )
    .select(['asset.id', 'asset.kind', 'asset.revision', 'asset.status', 'revision.document_sha256'])
    .where('asset.id', '=', assetId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    assetId: row.id,
    kind: row.kind as AssetKind,
    revision: row.revision,
    admitted: row.status === 'admitted',
    documentSha256: row.document_sha256 ?? undefined,
  };
}

/**
 * Reads the stored reading facts of one Scroll revision inside the caller's personal transaction,
 * validated on read (an unknown version is not cast to the latest shape). `undefined` when the
 * revision does not exist.
 */
export async function readScrollReadingFacts(
  scope: PersonalScopeTx,
  assetId: string,
  revision: number,
): Promise<ReadingFacts | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select(['revision.reading_facts', 'revision.document'])
    .where('revision.asset_id', '=', assetId)
    .where('revision.revision', '=', revision)
    .where('asset.kind', '=', 'scroll')
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const parsed = ReadingFactsSchema.safeParse(row.reading_facts);
  if (parsed.success) return parsed.data;
  // A facts-version rollout must not strand existing exposures. The immutable admitted document
  // contains everything needed to derive the current view; operators can persist it on re-import.
  const document = parseDocument(row.document);
  if (document.kind !== 'valid') throw new ReadingFactsUnavailableError();
  return readingFactsOf(document.document);
}

/** One stored revision's consumer document, read outside any personal transaction. */
export async function readStoredScrollDocument(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
): Promise<unknown> {
  const row = await db
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select('revision.document')
    .where('revision.asset_id', '=', assetId)
    .where('revision.revision', '=', revision)
    .where('asset.kind', '=', 'scroll')
    .where('asset.status', '=', 'admitted')
    .executeTakeFirst();
  return row?.document;
}

const admissions = new WeakMap<AdmissionTx, Transaction<Database>>();

function admissionTransaction(tx: AdmissionTx): Transaction<Database> {
  const trx = admissions.get(tx);
  if (trx === undefined) throw new Error('Admission transaction used after it ended');
  return trx;
}

/**
 * The admission store's transaction and write ports over one database. Admission is shared-content
 * bookkeeping with no personal root to lock: imports of one asset serialise on a transaction-scoped
 * advisory lock instead, so two imports never both create the asset or the same revision.
 */
export function makeAdmissionStore(
  db: Kysely<Database>,
): Pick<ImportEditorialScrollPorts, 'inAdmission' | 'lockAsset' | 'storeRevision' | 'refreshReadingFacts'> {
  return {
    inAdmission: (work) =>
      withTransaction(db, 'content.admission', async (trx) => {
        const tx = Object.freeze({}) as unknown as AdmissionTx;
        admissions.set(tx, trx);
        try {
          return await work(tx);
        } finally {
          admissions.delete(tx);
        }
      }),

    async lockAsset(tx, assetId): Promise<LockedAsset> {
      const trx = admissionTransaction(tx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${assetId}`}, 0))`.execute(trx);
      const asset = await trx
        .selectFrom('content.assets')
        .select(['kind', 'status', 'revision'])
        .where('id', '=', assetId)
        .executeTakeFirst();
      if (asset === undefined) return { kind: 'absent' };
      const stored = await trx
        .selectFrom('content.asset_revisions')
        .select('document_sha256')
        .where('asset_id', '=', assetId)
        .where('revision', '=', asset.revision)
        .executeTakeFirst();
      return {
        kind: 'present',
        assetKind: asset.kind as AssetKind,
        status: asset.status === 'admitted' ? 'admitted' : 'withdrawn',
        revision: asset.revision,
        documentSha256: stored?.document_sha256,
      };
    },

    async refreshReadingFacts(tx, assetId, revision, facts): Promise<boolean> {
      const result = await admissionTransaction(tx)
        .updateTable('content.asset_revisions')
        .set({ reading_facts: JSON.stringify(facts) })
        .where('asset_id', '=', assetId)
        .where('revision', '=', revision)
        .where(sql<boolean>`reading_facts is distinct from ${JSON.stringify(facts)}::jsonb`)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async storeRevision(tx, admitted): Promise<void> {
      const trx = admissionTransaction(tx);
      const { compiled } = admitted;
      if (admitted.createsAsset) {
        await trx
          .insertInto('content.assets')
          .values({ id: admitted.assetId, revision: admitted.revision, kind: 'scroll', status: 'admitted' })
          .execute();
      } else {
        await trx
          .updateTable('content.assets')
          .set({ revision: admitted.revision })
          .where('id', '=', admitted.assetId)
          .execute();
      }
      await trx
        .insertInto('content.asset_revisions')
        .values({
          asset_id: admitted.assetId,
          revision: admitted.revision,
          provenance_kind: admitted.provenanceKind,
          document_version: compiled.documentVersion,
          document: JSON.stringify(compiled.document),
          document_sha256: compiled.documentSha256,
          explanation_unit_id: compiled.explanationUnitId,
          language: compiled.language,
          title: compiled.title,
          reading_facts: JSON.stringify(compiled.readingFacts),
        })
        .execute();
      await trx
        .insertInto('content.asset_provenance')
        .values({
          asset_id: admitted.assetId,
          revision: admitted.revision,
          provenance_version: compiled.provenanceVersion,
          provenance: JSON.stringify(compiled.provenance),
        })
        .execute();
    },
  };
}
