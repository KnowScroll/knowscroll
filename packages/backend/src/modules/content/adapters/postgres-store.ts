import type { PersonalScopeTx } from '../../identity/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { AssetForAction } from '../public.js';

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
