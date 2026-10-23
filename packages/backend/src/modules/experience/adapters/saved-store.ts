import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { WithPersonalScope } from '../../identity/public.js';
import type { ReadSavedMetadata } from '../../content/public.js';
import type { ListSaved } from '../public.js';
export function hydratedSaved(withScope: WithPersonalScope, metadata: ReadSavedMetadata): ListSaved {
  return async (authority, limit) => {
    const entered = await withScope(authority, async (scope) => {
      const rows = await sql<{
        asset_id: string;
        asset_revision: number;
        saved_at: Date;
      }>`select asset_id,asset_revision,saved_at from experience.saved_items where universe_id=${scope.authority.universeId}::uuid order by saved_at desc,asset_id limit ${Math.max(1, Math.min(100, Math.trunc(limit)))}`.execute(
        transactionOf(scope),
      );
      const refs = rows.rows.map((r) => ({ assetId: r.asset_id, assetRevision: r.asset_revision }));
      const shared = await metadata(scope, refs);
      return {
        kind: 'read' as const,
        revision: scope.revisionAtEntry,
        items: rows.rows.map((r, i) => ({
          assetId: r.asset_id,
          assetRevision: r.asset_revision,
          savedAt: new Date(r.saved_at),
          ...(shared[i] && {
            metadata: shared[i].metadata,
            availability: shared[i].availability,
            currentAssetRevision: shared[i].currentAssetRevision,
          }),
        })),
      };
    });
    return entered.kind === 'entered'
      ? entered.value
      : {
          kind: 'refused',
          reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
        };
  };
}
