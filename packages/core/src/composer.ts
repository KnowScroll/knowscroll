import type { FeedAsset } from '../../contracts/src/inventory.ts';
/** Bootstrap policy. It records its selection reason and excludes explicit keeps.
 * It makes no inference about understanding, belief, or intrinsic interest.
 * ADR-0025: `assets` may now carry minted Reel items alongside Scrolls (the caller decides
 * whether and how to interleave them — see apps/api/src/app.ts); this function's own policy is
 * unchanged: filter kept, bound to 3, record why. */
export function compose(assets: FeedAsset[], keptIds: string[]) {
  const kept = new Set(keptIds);
  return assets.filter(a => !kept.has(a.assetId)).slice(0, 3).map(a => ({ ...a,
    reason: kept.size ? 'A different sourced encounter; already-kept Scrolls are excluded.' : 'An editorial starting encounter. No interests have been inferred.'
  }));
}
