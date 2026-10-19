/**
 * Content's public surface for other modules. The content module proper (inventory, immutable
 * revisions, publication, Cutroom import) arrives in Phase 2; today it answers one question:
 * does this asset exist, admitted, at this revision? The port is implemented by
 * `adapters/postgres-store.ts` and bound by the composition roots.
 */
import type { PersonalScopeTx } from '../identity/public.js';

/** The facts an action command needs about its target asset. */
export interface AssetForAction {
  readonly revision: number;
  readonly admitted: boolean;
}

/** Port: read one asset inside the caller's personal transaction (no lock). */
export type FindAssetForAction = (scope: PersonalScopeTx, assetId: string) => Promise<AssetForAction | undefined>;

export const FIND_ASSET_FOR_ACTION = Symbol('content.findAssetForAction');
