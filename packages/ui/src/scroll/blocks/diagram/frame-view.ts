import type { BlockOfType } from '@knowscroll/scroll-model';

type DiagramData = BlockOfType<'diagram'>['data'];

export interface FrameView {
  /** Nodes and edges the frame hides. */
  readonly hidden: ReadonlySet<string>;
  /** Nodes and edges the frame points at; everything else is quieter when any are named. */
  readonly emphasis: ReadonlySet<string>;
  readonly weights: ReadonlyMap<string, number>;
  /** The frame names something to emphasise, so the rest recedes. */
  readonly dims: boolean;
}

const NO_FRAME: FrameView = { hidden: new Set(), emphasis: new Set(), weights: new Map(), dims: false };

/** What the current frame does to the diagram: hides, emphasises, re-weights edges. */
export function frameView(data: DiagramData, frameId: string | null): FrameView {
  const frame = data.frames.find((candidate) => candidate.id === frameId);
  if (frame === undefined) return NO_FRAME;
  return {
    hidden: new Set(frame.hidden),
    emphasis: new Set(frame.emphasis),
    weights: new Map(frame.weights.map((entry) => [entry.edge, entry.weight])),
    dims: frame.emphasis.length > 0,
  };
}

/** Edge stroke width from its weight in [0, 1], an authored emphasis and never a measurement. */
export function strokeFor(weight: number | undefined): number {
  const value = weight ?? 0.35;
  return Math.round((1.2 + value * 6.8) * 10) / 10;
}
