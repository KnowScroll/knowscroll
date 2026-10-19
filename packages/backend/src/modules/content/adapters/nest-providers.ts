import { FIND_ASSET_FOR_ACTION, type FindAssetForAction } from '../public.js';
import { findAssetForAction } from './postgres-store.js';

/** Reusable outer wiring (blueprint §22): content's read ports. Composition roots only. */
export function contentProviders(): { readonly provide: symbol; readonly useValue: FindAssetForAction }[] {
  return [{ provide: FIND_ASSET_FOR_ACTION, useValue: findAssetForAction }];
}
