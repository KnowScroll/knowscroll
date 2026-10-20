import type { BlockOfType } from '@knowscroll/scroll-model';
import { CANVAS_WIDTH, type DiagramLayout, type PlacedNode, type Point } from './layout';

type Interaction = BlockOfType<'diagram'>['data']['interaction'];
export type DragToTarget = Extract<Interaction, { kind: 'drag-to-target' }>;

/** How far past a target's box a dropped token still counts as on it, in canvas units. */
const REACH = 18;

/** The target a token dropped at `point` is on: the nearest whose box (plus the reach) holds the point, or null. */
export function targetAt(
  layout: DiagramLayout,
  interaction: DragToTarget,
  point: Point,
): { node: string; frame: string } | null {
  let best: { node: string; frame: string; distance: number } | null = null;
  for (const target of interaction.targets) {
    const node = layout.nodes.find((candidate) => candidate.id === target.node);
    if (node === undefined) continue;
    const dx = Math.abs(point.x - node.x);
    const dy = Math.abs(point.y - node.y);
    if (dx > node.width / 2 + REACH || dy > node.height / 2 + REACH) continue;
    const distance = Math.hypot(point.x - node.x, point.y - node.y);
    if (best === null || distance < best.distance) best = { node: target.node, frame: target.frame, distance };
  }
  return best === null ? null : { node: best.node, frame: best.frame };
}

/** Keeps a dragged token inside the canvas. */
export function keepInside(layout: DiagramLayout, token: Pick<PlacedNode, 'width' | 'height'>, point: Point): Point {
  return {
    x: Math.min(CANVAS_WIDTH - token.width / 2, Math.max(token.width / 2, point.x)),
    y: Math.min(layout.height - token.height / 2, Math.max(token.height / 2, point.y)),
  };
}

/** The frame the diagram starts in and returns to on Reset. */
export function initialFrame(interaction: Interaction, firstFrame: string | undefined): string | undefined {
  return interaction.kind === 'drag-to-target' ? interaction.initialFrame : firstFrame;
}
