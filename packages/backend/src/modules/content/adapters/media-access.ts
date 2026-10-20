import { ReelDocumentSchema } from '@knowscroll/contracts';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeWithPersonalScope, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalAuthority } from '../../identity/public.js';

/** Rechecks authority under the root lock and reads only an admitted exposure's immutable media.
 * No I/O to the engine/filesystem takes place while this short transaction is open. */
export function makeMediaAccess(db: Kysely<Database>, lockTimeoutMs = 5000) {
  const withScope = makeWithPersonalScope(db, { lockTimeoutMs });
  return async (authority: PersonalAuthority, exposureId: string) => {
    const entered = await withScope(authority, async (scope) => {
      const result = await sql<{ document: unknown; logical_key: string; sha256: string; size_bytes: number }>`
        select r.document, m.logical_key, m.sha256, m.size_bytes
        from experience.exposures e
        join content.assets a on a.id = e.asset_id and a.kind = 'reel' and a.status = 'admitted'
        join content.asset_revisions r on r.asset_id = e.asset_id and r.revision = e.asset_revision
        join content.reel_imports i on i.asset_id = r.asset_id and i.asset_revision = r.revision
        join content.media_objects m on m.id = i.media_id
        where e.universe_id = ${scope.authority.universeId}::uuid and e.id = ${exposureId}::uuid
          and e.privacy_epoch = ${scope.authority.privacyEpoch} and e.kind = 'reel'`.execute(transactionOf(scope));
      const row = result.rows[0];
      if (!row) return undefined;
      const parsed = ReelDocumentSchema.safeParse(row.document);
      if (!parsed.success || parsed.data.mediaKey !== row.logical_key) return undefined;
      return { document: parsed.data, key: row.logical_key, sha256: row.sha256, size: row.size_bytes };
    });
    return entered.kind === 'entered' ? entered.value : undefined;
  };
}
