import type { BlockOfType } from '@knowscroll/scroll-model';

type DiagramData = BlockOfType<'diagram'>['data'];
type Node = DiagramData['nodes'][number];
type Edge = DiagramData['edges'][number];

/** The logical width every diagram is laid out in; it scales to the width of its block. */
export const CANVAS_WIDTH = 318;
const PADDING = 12;
const GAP_X = 12;
const ROW_HEIGHT = 34;
const ROW_GAP = 30;
const MIN_HEIGHT = 200;
/** A grid layout uses 6 × 6 cells (the package's `cell` coordinates). */
const GRID_CELLS = 6;
const GRID_ROW = 50;

export interface PlacedNode {
  readonly id: string;
  readonly label: string;
  readonly kind: Node['kind'];
  readonly group: string | undefined;
  /** Centre, in canvas units. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedGroup {
  readonly id: string;
  readonly label: string;
  readonly y: number;
  readonly height: number;
}

export interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PlacedNode[];
  readonly groups: readonly PlacedGroup[];
}

/** A label's drawn width: the faces have no text measurement here, so it is estimated from its length. */
function boxWidth(label: string, kind: Node['kind']): number {
  const base = Math.round(label.length * 7 + 26);
  return Math.min(132, Math.max(kind === 'token' ? 60 : 54, base));
}

function boxHeight(kind: Node['kind']): number {
  return kind === 'token' ? 40 : ROW_HEIGHT;
}

/** Longest-path depth of every node along directed edges (a cycle falls back to reading order). */
function depths(nodes: readonly Node[], edges: readonly Edge[]): Map<string, number> {
  const depth = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!edge.directed) continue;
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0) && next < nodes.length) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

/** Nodes in reading order, grouped by depth; a node never comes before the nodes that point to it. */
function layers(nodes: readonly Node[], edges: readonly Edge[]): Node[][] {
  const depth = depths(nodes, edges);
  const rows: Node[][] = [];
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    (rows[level] ??= []).push(node);
  }
  return rows.filter((row) => row.length > 0);
}

/** Packs boxes into rows that fit the canvas, left to right. */
function pack(items: readonly Node[]): Node[][] {
  const rows: Node[][] = [];
  let row: Node[] = [];
  let used = 0;
  for (const node of items) {
    const width = boxWidth(node.label, node.kind);
    if (row.length > 0 && used + GAP_X + width > CANVAS_WIDTH - 2 * PADDING) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length > 0 ? GAP_X : 0) + width;
    row.push(node);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function place(node: Node, x: number, y: number): PlacedNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    group: node.group,
    x,
    y,
    width: boxWidth(node.label, node.kind),
    height: boxHeight(node.kind),
  };
}

/** Centres each row in the canvas and stacks the rows. */
function stack(rows: readonly (readonly Node[])[]): { nodes: PlacedNode[]; height: number; content: number } {
  const placed: PlacedNode[] = [];
  rows.forEach((row, index) => {
    const total = row.reduce((sum, node) => sum + boxWidth(node.label, node.kind), 0) + GAP_X * (row.length - 1);
    let x = (CANVAS_WIDTH - total) / 2;
    const y = PADDING + ROW_HEIGHT / 2 + index * (ROW_HEIGHT + ROW_GAP);
    for (const node of row) {
      const width = boxWidth(node.label, node.kind);
      placed.push(place(node, x + width / 2, y));
      x += width + GAP_X;
    }
  });
  const content = PADDING * 2 + rows.length * ROW_HEIGHT + Math.max(0, rows.length - 1) * ROW_GAP;
  return { nodes: placed, height: Math.max(MIN_HEIGHT, content), content };
}

/** Moves a stack down so its content is vertically centred when the canvas is taller than it. */
function centred(nodes: readonly PlacedNode[], content: number, height: number): PlacedNode[] {
  const shift = (height - content) / 2;
  return shift > 0 ? nodes.map((node) => ({ ...node, y: node.y + shift })) : [...nodes];
}

function ring(
  nodes: readonly Node[],
  centre: { x: number; y: number },
  rx: number,
  ry: number,
  start: number,
): PlacedNode[] {
  return nodes.map((node, index) => {
    const angle = start + (index * 2 * Math.PI) / Math.max(1, nodes.length);
    const width = boxWidth(node.label, node.kind);
    const x = Math.min(
      CANVAS_WIDTH - PADDING - width / 2,
      Math.max(PADDING + width / 2, centre.x + rx * Math.cos(angle)),
    );
    return place(node, x, centre.y + ry * Math.sin(angle));
  });
}

/**
 * Lays a diagram out in canvas units, with no model-written coordinates: the layout kind and the
 * order of the nodes decide everything (the grid layout alone uses the 6 × 6 cells the document
 * names). Pure, so it is the same on every platform.
 * - `flow-lr`: nodes in reading order, left to right, wrapping when a row is full;
 * - `flow-tb`: one row per depth along the directed edges;
 * - `layers`: one band per group (or per depth when there are none);
 * - `radial`: the first node in the middle, the rest around it;
 * - `cycle`: every node on a ring;
 * - `grid`: each node in its cell.
 */
export function layoutDiagram(data: DiagramData): DiagramLayout {
  const { nodes, edges, layout } = data;
  if (layout === 'grid') {
    const cellWidth = CANVAS_WIDTH / GRID_CELLS;
    const placed = nodes.map((node) =>
      place(node, ((node.cell?.column ?? 0) + 0.5) * cellWidth, ((node.cell?.row ?? 0) + 0.5) * GRID_ROW),
    );
    return { width: CANVAS_WIDTH, height: GRID_CELLS * GRID_ROW, nodes: placed, groups: [] };
  }
  if (layout === 'radial' || layout === 'cycle') {
    const height = 300;
    const centre = { x: CANVAS_WIDTH / 2, y: height / 2 };
    const rx = (CANVAS_WIDTH - 2 * PADDING - 100) / 2;
    const ry = (height - 2 * PADDING - ROW_HEIGHT) / 2;
    if (layout === 'cycle') {
      return { width: CANVAS_WIDTH, height, nodes: ring(nodes, centre, rx, ry, -Math.PI / 2), groups: [] };
    }
    const [hub, ...rest] = nodes;
    const placed =
      hub === undefined ? [] : [place(hub, centre.x, centre.y), ...ring(rest, centre, rx, ry, -Math.PI / 2)];
    return { width: CANVAS_WIDTH, height, nodes: placed, groups: [] };
  }
  if (layout === 'flow-lr') {
    const rows = pack(layers(nodes, edges).flat());
    const stacked = stack(rows);
    return {
      width: CANVAS_WIDTH,
      height: stacked.height,
      nodes: centred(stacked.nodes, stacked.content, stacked.height),
      groups: [],
    };
  }
  // flow-tb and layers: a row per depth; layers with groups: a row per group in the order of the groups.
  let rows: Node[][];
  let groups: PlacedGroup[] = [];
  if (layout === 'layers' && data.groups.length > 0) {
    const ordered = data.groups.map((group) => nodes.filter((node) => node.group === group.id));
    const ungrouped = nodes.filter(
      (node) => node.group === undefined || !data.groups.some((group) => group.id === node.group),
    );
    rows = [...ordered, ungrouped].filter((row) => row.length > 0).flatMap((row) => pack(row));
  } else {
    rows = layers(nodes, edges).flatMap((row) => pack(row));
  }
  const stacked = stack(rows);
  const settled = centred(stacked.nodes, stacked.content, stacked.height);
  if (layout === 'layers' && data.groups.length > 0) {
    groups = data.groups.flatMap((group) => {
      const members = settled.filter((node) => node.group === group.id);
      if (members.length === 0) return [];
      const top = Math.min(...members.map((node) => node.y - node.height / 2)) - 10;
      const bottom = Math.max(...members.map((node) => node.y + node.height / 2)) + 10;
      return [{ id: group.id, label: group.label, y: top, height: bottom - top }];
    });
  }
  return {
    width: CANVAS_WIDTH,
    height: stacked.height,
    nodes: settled,
    groups,
  };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where a line from a box's centre toward another point leaves the box (so arrows touch edges, not centres). */
export function boxEdge(node: Pick<PlacedNode, 'x' | 'y' | 'width' | 'height'>, toward: Point): Point {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
  const halfW = node.width / 2;
  const halfH = node.height / 2;
  const scale = Math.min(halfW / Math.abs(dx || 1e-9), halfH / Math.abs(dy || 1e-9));
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

/** The two ends of an edge, clipped to the boxes it joins. */
export function edgeEnds(from: PlacedNode, to: PlacedNode): { from: Point; to: Point } {
  return { from: boxEdge(from, to), to: boxEdge(to, from) };
}
