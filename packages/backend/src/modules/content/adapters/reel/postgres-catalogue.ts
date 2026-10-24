import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../../infrastructure/postgres/database.js';
import { reelFingerprints, type ReelOnRecord } from '../../domain/reel/fingerprint.js';
import { ReelBriefSchema } from '../../domain/reel/script.js';
import type { ReelCatalogue } from '../../application/reel/ports.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * What the Reel commands read of this world's shared content: whether the twin Scroll is admitted
 * at the named revision, and the briefs of every Reel already here, for the repetition rule. A
 * stored brief that does not parse stops the command: a Reel that cannot be fingerprinted must not
 * quietly let a repeat through.
 */
export function postgresReelCatalogue(db: Kysely<Database>): ReelCatalogue {
  return {
    async admittedScroll(assetId, revision) {
      const { rows } = await sql<{ explanation_unit_id: string }>`select r.explanation_unit_id
        from content.assets a
        join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision
        where a.id = ${assetId}::uuid and a.kind = 'scroll' and a.status = 'admitted' and a.revision = ${revision}`.execute(
        db,
      );
      return rows[0] === undefined ? undefined : { assetId, revision, explanationUnitId: rows[0].explanation_unit_id };
    },

    async reelsOnRecord(exceptAssetId): Promise<readonly ReelOnRecord[]> {
      const { rows } = await sql<{
        asset_id: string;
        brief: unknown;
      }>`select r.asset_id, p.provenance -> 'brief' as brief
        from content.asset_revisions r
        join content.asset_provenance p on p.asset_id = r.asset_id and p.revision = r.revision
        where r.provenance_kind = 'cutroom_import' and r.asset_id <> ${exceptAssetId}::uuid`.execute(db);
      return rows.map((row) => {
        const brief = ReelBriefSchema.safeParse(row.brief);
        if (!brief.success) throw new Error('REEL_CORPUS_UNREADABLE');
        return { label: row.asset_id, ...reelFingerprints(brief.data, sha256) };
      });
    },
  };
}
