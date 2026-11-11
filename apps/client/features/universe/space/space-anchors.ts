import * as THREE from 'three';
import type { RigFocus } from './camera-rig';
import { ANCHOR_CAP, fromMiddle, onScreen } from './detail-set';
import type { BuiltSpace } from './scene/build-scene';
import type { SpaceAnchor } from './space-surface';

/** A system drawn as a point is a tap target about this big on the screen, whatever the distance, in layout pixels. */
export const FAR_RADIUS_PX = 10;

/** Buffers the far systems are projected into, kept across frames so thousands of systems allocate nothing per frame. */
export interface AnchorScratch {
  from?: Float32Array;
  x?: Float32Array;
  y?: Float32Array;
  pool?: Float32Array;
}

const NOT_SHOWN = Number.POSITIVE_INFINITY;

/**
 * The named points of a scene on the screen, for the labels and tap targets laid over the canvas.
 *
 * A map drawn whole answers with every anchor it has, as it always did. A map at scale (D-417) answers with what the
 * person can reach: the anchors of systems built in full, projected from their objects, and the systems that are only
 * points, projected from their places; nothing outside the screen (a margin aside), no planet from the whole map,
 * nothing outside the system in view, and never more than {@link ANCHOR_CAP}, those nearest the middle of the screen
 * first. The answer keeps the scene's own order, so keyboard focus does not jump as bodies move.
 */
export function projectAnchors(
  space: BuiltSpace,
  size: { readonly width: number; readonly height: number },
  focus: RigFocus | undefined,
  scratch: AnchorScratch = {},
): SpaceAnchor[] {
  space.camera.updateMatrixWorld();
  const point = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const right = new THREE.Vector3().setFromMatrixColumn(space.camera.matrixWorld, 0);
  const scaled = space.scaled;
  const built: { readonly anchor: SpaceAnchor; readonly from: number }[] = [];
  for (const { id, kind, name, caption, mapCaption, systemId, object, radius } of space.anchors) {
    if (scaled && !reachable(kind, systemId, focus)) continue;
    object.getWorldPosition(point);
    edge.copy(point).addScaledVector(right, radius);
    point.project(space.camera);
    edge.project(space.camera);
    if (scaled && !onScreen(point)) continue;
    const x = (point.x * 0.5 + 0.5) * size.width;
    const y = (-point.y * 0.5 + 0.5) * size.height;
    built.push({
      anchor: {
        id,
        kind,
        name,
        ...(caption === undefined ? {} : { caption }),
        ...(mapCaption === undefined ? {} : { mapCaption }),
        systemId,
        x,
        y,
        radiusPx: Math.abs((edge.x * 0.5 + 0.5) * size.width - x),
        visible: point.z < 1 && object.visible,
      },
      from: fromMiddle(point),
    });
  }
  if (!scaled) return built.map(({ anchor }) => anchor);

  let kept = built;
  if (kept.length > ANCHOR_CAP) kept = nearest(kept, ANCHOR_CAP);
  const budget = ANCHOR_CAP - kept.length;
  const anchors = kept.map(({ anchor }) => anchor);
  if (focus?.kind !== 'system' && budget > 0) anchors.push(...farAnchors(space, size, budget, scratch, point));
  return anchors;
}

/** Whether the screen may be given an anchor of this kind and system, for the view in focus. */
function reachable(kind: SpaceAnchor['kind'], systemId: string | null, focus: RigFocus | undefined): boolean {
  if (focus?.kind === 'system') return kind === 'dust' || systemId === focus.systemId;
  return kind !== 'planet';
}

/** The `count` entries nearest the middle of the screen, in the order they came. */
function nearest<T extends { readonly from: number }>(entries: readonly T[], count: number): T[] {
  const ranked = Float32Array.from(entries, (entry) => entry.from).sort();
  const limit = ranked[count - 1]!;
  const picked: T[] = [];
  for (const entry of entries) if (entry.from <= limit && picked.length < count) picked.push(entry);
  return picked;
}

/**
 * The systems drawn as points that are on the screen, at most `budget` of them, the nearest to its middle. Each is
 * projected from its place into reused buffers; only the few that are kept become objects.
 */
function farAnchors(
  space: BuiltSpace,
  size: { readonly width: number; readonly height: number },
  budget: number,
  scratch: AnchorScratch,
  point: THREE.Vector3,
): SpaceAnchor[] {
  const { ids, names, x, z } = space.places;
  const count = ids.length;
  if (scratch.from?.length !== count) {
    scratch.from = new Float32Array(count);
    scratch.x = new Float32Array(count);
    scratch.y = new Float32Array(count);
    scratch.pool = new Float32Array(count);
  }
  const { from, x: px, y: py, pool } = scratch as Required<AnchorScratch>;
  const inDetail = space.detail;
  let shown = 0;
  for (let at = 0; at < count; at++) {
    from[at] = NOT_SHOWN;
    if (inDetail.has(ids[at]!)) continue;
    point.set(x[at]!, 0, z[at]).project(space.camera);
    if (point.z >= 1 || !onScreen(point)) continue;
    from[at] = fromMiddle(point);
    px[at] = (point.x * 0.5 + 0.5) * size.width;
    py[at] = (-point.y * 0.5 + 0.5) * size.height;
    pool[shown++] = from[at]!;
  }
  if (shown === 0) return [];
  const limit = shown > budget ? pool.slice(0, shown).sort()[budget - 1]! : NOT_SHOWN;
  const anchors: SpaceAnchor[] = [];
  for (let at = 0; at < count && anchors.length < budget; at++) {
    if (from[at] === NOT_SHOWN || from[at]! > limit) continue;
    anchors.push({
      id: ids[at]!,
      kind: 'system',
      name: names[at]!,
      systemId: ids[at]!,
      x: px[at]!,
      y: py[at]!,
      radiusPx: FAR_RADIUS_PX,
      visible: true,
    });
  }
  return anchors;
}
