/**
 * Content's public surface for other modules. The content module proper (inventory, immutable
 * revisions, publication, Cutroom import) arrives in Phase 2; today it answers one question:
 * does this asset exist, admitted, at this revision?
 */
export { findAssetForAction, type AssetForAction } from './adapters/postgres-store.js';
