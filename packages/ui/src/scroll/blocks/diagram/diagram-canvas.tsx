import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { content, fontFamily } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import type { FrameView } from './frame-view';
import { strokeFor } from './frame-view';
import { edgeEnds, type DiagramLayout, type PlacedNode, type Point } from './layout';

type DiagramData = BlockOfType<'diagram'>['data'];

const DIM = 0.4;

export interface CanvasProps {
  readonly data: DiagramData;
  readonly layout: DiagramLayout;
  readonly view: FrameView;
  /** The draggable token, if the diagram has one. */
  readonly tokenId: string | null;
  /** Where the token is while it is dragged (canvas units); otherwise it rests at its place. */
  readonly tokenAt: Point | null;
  /** The target the token is over right now. */
  readonly overNode: string | null;
}

function arrowHead(tip: Point, from: Point, size: number): string {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const left = { x: tip.x - size * Math.cos(angle - 0.45), y: tip.y - size * Math.sin(angle - 0.45) };
  const right = { x: tip.x - size * Math.cos(angle + 0.45), y: tip.y - size * Math.sin(angle + 0.45) };
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

function shape(
  node: PlacedNode,
  key: string,
  props: { dim: boolean; over: boolean; moved: Point | null },
): ReactElement {
  const x = (props.moved?.x ?? node.x) - node.width / 2;
  const y = (props.moved?.y ?? node.y) - node.height / 2;
  const opacity = props.dim ? DIM : 1;
  const token = node.kind === 'token';
  const fill = token ? content.ink : node.kind === 'note' ? content.paper2 : content.paper;
  const ink = token ? content.paper : content.ink;
  const centre = { x: x + node.width / 2, y: y + node.height / 2 };
  const radius = node.kind === 'process' ? 8 : node.kind === 'store' ? 4 : node.kind === 'note' ? 6 : node.height / 2;
  return (
    <G key={key} opacity={opacity}>
      {props.over ? (
        <Rect
          x={x - 5}
          y={y - 5}
          width={node.width + 10}
          height={node.height + 10}
          rx={radius + 5}
          fill="none"
          stroke={content.paper}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      <Rect
        x={x}
        y={y}
        width={node.width}
        height={node.height}
        rx={radius}
        fill={fill}
        stroke={token ? content.paper : content.ink}
        strokeWidth={node.kind === 'process' || node.kind === 'actor' ? 2.5 : token ? 2 : 0}
        strokeDasharray={node.kind === 'note' ? '5 4' : undefined}
      />
      {node.kind === 'store' ? (
        <Line x1={x} x2={x + node.width} y1={y + 8} y2={y + 8} stroke={content.ink} strokeWidth={1.5} />
      ) : null}
      <SvgText
        x={centre.x}
        y={centre.y + (node.kind === 'store' ? 5 : 4.5)}
        textAnchor="middle"
        fontFamily={fontFamily.text}
        fontWeight="600"
        fontSize={node.label.length > 14 ? 12 : 13}
        fill={ink}
      >
        {node.label}
      </SvgText>
      {token
        ? [-12, -4, 4, 12].map((offset) => (
            <Circle key={offset} cx={centre.x + offset} cy={y + node.height + 6} r={1.8} fill={content.paper} />
          ))
        : null}
    </G>
  );
}

/**
 * The diagram as SVG in canvas units: cobalt ground, cream nodes, cream edges whose weight is the
 * authored emphasis. The current frame hides nodes and edges, points at others (the rest recede)
 * and re-weights edges; while the token is dragged its edges follow it. Decorative to assistive
 * technology: the block around it carries the name, the frame description and every control.
 */
export function DiagramCanvas({ data, layout, view, tokenId, tokenAt, overNode }: CanvasProps) {
  const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
  const moved = (node: PlacedNode): PlacedNode =>
    node.id === tokenId && tokenAt !== null ? { ...node, x: tokenAt.x, y: tokenAt.y } : node;
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${layout.width} ${layout.height}`}>
      <Rect x={0} y={0} width={layout.width} height={layout.height} rx={12} fill={content.accent} />
      {layout.groups.map((group) => (
        <G key={group.id}>
          <Rect
            x={8}
            y={group.y}
            width={layout.width - 16}
            height={group.height}
            rx={10}
            fill={content.paper}
            fillOpacity={0.12}
          />
          <SvgText x={16} y={group.y + 11} fontFamily={fontFamily.mono} fontSize={9} fill={content.paper}>
            {group.label.toUpperCase()}
          </SvgText>
        </G>
      ))}
      {data.edges.map((edge) => {
        if (view.hidden.has(edge.id) || view.hidden.has(edge.from) || view.hidden.has(edge.to)) return null;
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const ends = edgeEnds(moved(from), moved(to));
        const dim = view.dims && !view.emphasis.has(edge.id);
        const width = strokeFor(view.weights.get(edge.id) ?? edge.weight);
        const mid = { x: (ends.from.x + ends.to.x) / 2, y: (ends.from.y + ends.to.y) / 2 };
        return (
          <G key={edge.id} opacity={dim ? DIM : 1}>
            <Line
              x1={ends.from.x}
              y1={ends.from.y}
              x2={ends.to.x}
              y2={ends.to.y}
              stroke={content.paper}
              strokeWidth={width}
              strokeLinecap="round"
              strokeDasharray={edge.style === 'dashed' ? '6 5' : undefined}
            />
            {edge.directed ? <Polygon points={arrowHead(ends.to, ends.from, 6 + width)} fill={content.paper} /> : null}
            {edge.label === undefined ? null : (
              <SvgText
                x={mid.x}
                y={mid.y - 5}
                textAnchor="middle"
                fontFamily={fontFamily.mono}
                fontSize={9}
                fill={content.paper}
              >
                {edge.label}
              </SvgText>
            )}
          </G>
        );
      })}
      {layout.nodes
        .filter((node) => !view.hidden.has(node.id) && node.id !== tokenId)
        .map((node) =>
          shape(node, node.id, {
            dim: view.dims && !view.emphasis.has(node.id),
            over: node.id === overNode,
            moved: null,
          }),
        )}
      {layout.nodes
        .filter((node) => node.id === tokenId && !view.hidden.has(node.id))
        .map((node) => shape(node, node.id, { dim: false, over: false, moved: tokenAt }))}
    </Svg>
  );
}
