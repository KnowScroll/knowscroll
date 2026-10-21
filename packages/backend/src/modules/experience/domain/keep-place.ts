/** Representation bound only. Content supplies actual immutable duration/top-level anchors. */
export const KEEP_MAX_REVISION = Number.MAX_SAFE_INTEGER;
export const KEEP_ROOT_MAX_REVISION = 2_147_483_647;
export type PlacePosition =
  | { readonly kind: 'reel'; readonly positionMs: number }
  | { readonly kind: 'scroll'; readonly blockId: string; readonly offsetWithinBlock: number };
export type PositionTarget =
  | { readonly kind: 'reel'; readonly durationMs: number }
  | { readonly kind: 'scroll'; readonly topLevelBlockIds: readonly string[] };
export function nextKeepRevision(base: number): number | undefined {
  return Number.isSafeInteger(base) && base >= 0 && base < KEEP_MAX_REVISION ? base + 1 : undefined;
}
export function positionForTarget(position: PlacePosition, target: PositionTarget): PlacePosition | undefined {
  if (position.kind === 'reel' && target.kind === 'reel')
    return { kind: 'reel', positionMs: Math.min(position.positionMs, target.durationMs) };
  if (position.kind === 'scroll' && target.kind === 'scroll' && target.topLevelBlockIds.includes(position.blockId))
    return { kind: 'scroll', blockId: position.blockId, offsetWithinBlock: position.offsetWithinBlock };
  return undefined;
}
