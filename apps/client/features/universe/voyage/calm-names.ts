import type { SpaceAnchor } from '../space/space-surface';
import { isQuiet, type UniverseIndex } from '../universe-layout';

/**
 * With Lately on, the stars and planets with nothing new for a month dim their written names (the prototype's 0.7; the old
 * look's `calm` label). Only stars and planets: a region's name stays as it is, so a calm name never sits beside the grey of
 * land not reached and blurs the two. Quiet changes how a place is drawn, never whether it exists.
 */
export function calmNames(
  anchors: readonly Pick<SpaceAnchor, 'id' | 'kind'>[],
  index: Pick<UniverseIndex, 'byId'>,
  lately: boolean,
): ReadonlySet<string> {
  const calm = new Set<string>();
  if (!lately) return calm;
  for (const anchor of anchors) {
    if (anchor.kind !== 'system' && anchor.kind !== 'planet') continue;
    const place = index.byId.get(anchor.id);
    if (place !== undefined && isQuiet(place)) calm.add(anchor.id);
  }
  return calm;
}
