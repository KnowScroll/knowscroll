import type { BlockOfType } from '@knowscroll/scroll-model';
import { frameView } from './frame-view';

type DiagramData = BlockOfType<'diagram'>['data'];

export interface DiagramDescription {
  /** The current frame's label and description, when the diagram has frames. */
  readonly frame: { readonly label: string; readonly description: string } | null;
  readonly nodes: readonly string[];
  /** "Deck → Cables (hands weight on)", or "A — B" for an edge without a direction. */
  readonly connections: readonly string[];
}

/**
 * The text version of a diagram: what is in it and how it is joined, for the frame the reader is
 * on (the nodes and edges a frame hides are left out). Built from the document alone.
 */
export function describeDiagram(data: DiagramData, frameId: string | null): DiagramDescription {
  const view = frameView(data, frameId);
  const labelOf = new Map(data.nodes.map((node) => [node.id, node.label]));
  const frame = data.frames.find((candidate) => candidate.id === frameId);
  const connections = data.edges
    .filter((edge) => !view.hidden.has(edge.id) && !view.hidden.has(edge.from) && !view.hidden.has(edge.to))
    .map((edge) => {
      const from = labelOf.get(edge.from) ?? edge.from;
      const to = labelOf.get(edge.to) ?? edge.to;
      const label = edge.label === undefined ? '' : ` (${edge.label})`;
      return `${from} ${edge.directed ? '→' : '—'} ${to}${label}`;
    });
  return {
    frame: frame === undefined ? null : { label: frame.label, description: frame.description },
    nodes: data.nodes.filter((node) => !view.hidden.has(node.id)).map((node) => node.label),
    connections,
  };
}
