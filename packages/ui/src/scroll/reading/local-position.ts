/** Private caller-owned position; never an observation or URL/wire field. */
export interface ScrollLocalPosition {
  readonly assetId: string;
  readonly revision: number;
  readonly blockId: string;
  /** Pixels below the block top at the unobscured reading edge. */
  readonly offsetWithinBlock: number;
}

export interface ScrollPositionHandle {
  /** Read synchronously before parking/unmounting; null until geometry exists. */
  capture(): ScrollLocalPosition | null;
}

export interface PositionBox {
  readonly top: number;
  readonly height: number;
}

export function captureBlockPosition(boxes: ReadonlyMap<string, PositionBox>, edge: number) {
  let selected: { blockId: string; box: PositionBox } | null = null;
  for (const [blockId, box] of boxes) {
    if (box.height <= 0) continue;
    if (
      selected === null ||
      (box.top <= edge && box.top > selected.box.top) ||
      (selected.box.top > edge && box.top < selected.box.top)
    )
      selected = { blockId, box };
  }
  return selected === null
    ? null
    : {
        blockId: selected.blockId,
        offsetWithinBlock: Math.max(0, Math.min(selected.box.height, edge - selected.box.top)),
      };
}

export function restoreBlockPosition(box: PositionBox, offset: number, inset: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, box.top + Math.max(0, Math.min(box.height, offset)) - inset));
}

export interface PositionBinding {
  readonly initial: Pick<ScrollLocalPosition, 'blockId' | 'offsetWithinBlock'> | null;
  readonly changed: () => void;
  readonly scrollTo: (y: number) => void;
}
