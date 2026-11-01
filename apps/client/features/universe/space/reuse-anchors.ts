import type { SpaceAnchor } from './space-surface';

/** A label that moved less than this many pixels has not moved. */
const SAME_PLACE_PX = 0.5;

/**
 * The anchors to show after a frame: each one that has not visibly moved is the very object shown
 * before, so labels that hold still do not render again at 30 Hz. Returns `previous` itself when
 * nothing changed.
 */
export function reuseUnchangedAnchors(
  previous: readonly SpaceAnchor[],
  next: readonly SpaceAnchor[],
): readonly SpaceAnchor[] {
  const before = new Map(previous.map((anchor) => [anchor.id, anchor]));
  let changed = next.length !== previous.length;
  const merged = next.map((anchor) => {
    const old = before.get(anchor.id);
    if (
      old !== undefined &&
      old.visible === anchor.visible &&
      old.name === anchor.name &&
      old.caption === anchor.caption &&
      old.mapCaption === anchor.mapCaption &&
      Math.abs(old.radiusPx - anchor.radiusPx) < SAME_PLACE_PX &&
      Math.abs(old.x - anchor.x) < SAME_PLACE_PX &&
      Math.abs(old.y - anchor.y) < SAME_PLACE_PX
    ) {
      return old;
    }
    changed = true;
    return anchor;
  });
  return changed ? merged : previous;
}
