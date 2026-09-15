import type { ScrollAsset } from '../../contracts/src/index.ts';
/** Bootstrap policy. It records its selection reason and excludes explicit keeps.
 * It makes no inference about understanding, belief, or intrinsic interest. */
export function compose(assets: ScrollAsset[], keptIds: string[]) {
  const kept = new Set(keptIds);
  return assets.filter(a => !kept.has(a.assetId)).slice(0, 3).map(a => ({ ...a,
    reason: kept.size ? 'A different sourced encounter; already-kept Scrolls are excluded.' : 'An editorial starting encounter. No interests have been inferred.'
  }));
}
