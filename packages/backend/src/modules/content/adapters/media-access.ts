import { ReelDocumentSchema } from '@knowscroll/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeWithPersonalScope, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalAuthority } from '../../identity/public.js';

/** Exact immutable source binding. A document/media key alone cannot adopt another source. */
export async function readReelMediaBinding(
  trx: Transaction<Database>,
  ref: { readonly assetId: string; readonly assetRevision: number },
) {
  const rows = (
    await sql<{
      logical_key: string;
      sha256: string;
      size: string;
      backend: string;
      mime: string;
      source: string;
      expected_sha: string | null;
      expected_bytes: string | null;
    }>`
    select m.logical_key,m.sha256,m.size_bytes::text size,m.backend,m.mime,bound.source,bound.expected_sha,bound.expected_bytes from (
      select media_id,'legacy' source,null::text expected_sha,null::text expected_bytes from content.reel_imports where asset_id=${ref.assetId}::uuid and asset_revision=${ref.assetRevision}
      union all select media_id,'commission',publication_utf8::jsonb->>'mediaSha256',publication_utf8::jsonb->>'mediaBytes' from content.cutroom_publications where asset_id=${ref.assetId}::uuid and asset_revision=${ref.assetRevision}
      union all select media_id,'receive',payload_utf8::jsonb->'media'->>'sha256',payload_utf8::jsonb->'media'->>'sizeBytes' from content.cutroom_receive_receipts where asset_id=${ref.assetId}::uuid and asset_revision=${ref.assetRevision} and state='admitted'
    ) bound join content.media_objects m on m.id=bound.media_id limit 2`.execute(trx)
  ).rows;
  if (rows.length !== 1) return;
  const row = rows[0]!;
  if (row.source !== 'legacy' && (row.expected_sha !== row.sha256 || row.expected_bytes !== row.size)) return;
  const size = Number(row.size);
  if (
    !/^[0-9a-f]{64}$/.test(row.sha256) ||
    row.logical_key !== `sha256/${row.sha256.slice(0, 2)}/${row.sha256}.mp4` ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 64 * 1024 * 1024 ||
    row.backend !== 'local' ||
    row.mime !== 'video/mp4'
  )
    return;
  return { key: row.logical_key, sha256: row.sha256, size };
}

/** Rechecks authority under the root lock and reads only an admitted exposure's immutable media.
 * No I/O to the engine/filesystem takes place while this short transaction is open. */
export function makeMediaAccess(db: Kysely<Database>, lockTimeoutMs = 5000) {
  const withScope = makeWithPersonalScope(db, { lockTimeoutMs });
  return async (authority: PersonalAuthority, exposureId: string) => {
    const entered = await withScope(authority, async (scope) => {
      const trx = transactionOf(scope);
      const exposure = await trx
        .selectFrom('experience.exposures')
        .select(['asset_id', 'asset_revision'])
        .where('universe_id', '=', scope.authority.universeId)
        .where('privacy_epoch', '=', scope.authority.privacyEpoch)
        .where('id', '=', exposureId)
        .where('kind', '=', 'reel')
        .executeTakeFirst();
      if (!exposure) return;
      const locked = await trx
        .selectFrom('content.assets')
        .select('id')
        .where('id', '=', exposure.asset_id)
        .forShare()
        .executeTakeFirst();
      if (!locked) return;
      // Re-read head/status AFTER the SHARE wait, under the same live personal authority.
      const result = await sql<{ document: unknown }>`
        select r.document
        from experience.exposures e
        join content.assets a on a.id = e.asset_id and a.kind = 'reel' and a.status = 'admitted' and a.revision=e.asset_revision
        join content.asset_revisions r on r.asset_id = e.asset_id and r.revision = e.asset_revision
        where e.universe_id = ${scope.authority.universeId}::uuid and e.id = ${exposureId}::uuid
          and e.privacy_epoch = ${scope.authority.privacyEpoch} and e.kind = 'reel'`.execute(trx);
      const row = result.rows[0];
      if (!row) return undefined;
      const parsed = ReelDocumentSchema.safeParse(row.document);
      const media = await readReelMediaBinding(trx, {
        assetId: exposure.asset_id,
        assetRevision: exposure.asset_revision,
      });
      if (
        !parsed.success ||
        !media ||
        parsed.data.assetId !== exposure.asset_id ||
        parsed.data.revision !== exposure.asset_revision ||
        parsed.data.mediaKey !== media.key
      )
        return undefined;
      return { document: parsed.data, ...media };
    });
    return entered.kind === 'entered' ? entered.value : undefined;
  };
}
