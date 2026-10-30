import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { HasActivatedExposure, ReadVisitedAssets } from '../public.js';

/** Most assets one read can ask about; a thread's sequence holds at most 99 episodes. */
const MAX_ASSETS = 100;

/**
 * See `ReadVisitedAssets`. Reads only this universe's own exposures at its current epoch, so a
 * Clear that removed them leaves nothing to report and nobody else's history is reachable.
 */
export const readVisitedAssets: ReadVisitedAssets = async (scope, assetIds) => {
  if (assetIds.length === 0) return new Set();
  if (assetIds.length > MAX_ASSETS) throw new Error('VISITED_ASSETS_LIMIT');
  const rows = await transactionOf(scope)
    .selectFrom('experience.exposures')
    .select('asset_id')
    .distinct()
    .where('universe_id', '=', scope.authority.universeId)
    .where('privacy_epoch', '=', scope.authority.privacyEpoch)
    .where('activated_at', 'is not', null)
    .where('asset_id', 'in', [...assetIds])
    .execute();
  return new Set(rows.map((row) => row.asset_id));
};

/** See `HasActivatedExposure`. */
export const hasActivatedExposure: HasActivatedExposure = async (scope, assetId, assetRevision) => {
  const row = await transactionOf(scope)
    .selectFrom('experience.exposures')
    .select('id')
    .where('universe_id', '=', scope.authority.universeId)
    .where('privacy_epoch', '=', scope.authority.privacyEpoch)
    .where('asset_id', '=', assetId)
    .where('asset_revision', '=', assetRevision)
    .where('kind', '=', 'scroll')
    .where('activated_at', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
};
