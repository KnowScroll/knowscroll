import type { PictureItem, PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, PictureShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import { BOLD_SLACK, inner, isLit, itemOpacity, LABEL_LINE_HEIGHT, labelShape, RECEDED, toneRole } from './common';

type CyclePicture = PictureOfKind<'cycle'>;

/** The smallest label a ring shrinks to before it gives up on a tight box. */
const SMALLEST_LABEL = 7;
/** The widest a label is allowed to wrap to, in label sizes: a longer line stops reading as a label of a node. */
const LABEL_WIDTH_IN_SIZES = 12;
const MAX_LABEL_LINES = 3;
/** Nodes more than this far from the vertical axis (as a share of the radius) take a label at their side. */
const SIDE_THRESHOLD = 0.3;
/** How far a label stays from the ring and the box edges, beyond what its text needs. */
const CLEARANCE = 2;
/** The shortest visible arc between two nodes: room for a line and its arrowhead. */
const MIN_ARC = 16;
const MIN_CENTRE_RADIUS = 5;
const MAX_CENTRE_RADIUS = 34;

interface Rectangle {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Where a label sits relative to its node. */
type Side = 'right' | 'left' | 'above' | 'below';

/** The sizes that stay the same across every state of a picture, so a glide moves shapes and never resizes them. */
interface Metrics {
  readonly size: number;
  /** The radius of a lit node, which every node's room is made for. */
  readonly nodeRadius: number;
  readonly gap: number;
}

interface Ring {
  readonly centreX: number;
  readonly centreY: number;
  readonly radius: number;
}

interface PlacedLabel {
  readonly side: Side;
  readonly x: number;
  readonly y: number;
  readonly lines: readonly string[];
  readonly rectangle: Rectangle;
}

/** One item of the ring: its angle, node position and label. */
interface PlacedItem {
  readonly angle: number;
  readonly x: number;
  readonly y: number;
  readonly label: PlacedLabel;
}

interface PlacedCentre {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly lines: readonly string[];
  readonly baseline: number;
  readonly rectangle: Rectangle;
}

interface Placement {
  readonly items: readonly PlacedItem[];
  readonly centre: PlacedCentre | undefined;
  /** Whether every label is inside the box, clear of the others and of the ring. */
  readonly fits: boolean;
}

const rectanglesTouch = (a: Rectangle, b: Rectangle): boolean =>
  a.left < b.right + CLEARANCE &&
  b.left < a.right + CLEARANCE &&
  a.top < b.bottom + CLEARANCE &&
  b.top < a.bottom + CLEARANCE;

/** The distance from a point to the nearest point of a rectangle (0 inside it). */
function distanceToRectangle(rectangle: Rectangle, x: number, y: number): number {
  const dx = Math.max(rectangle.left - x, 0, x - rectangle.right);
  const dy = Math.max(rectangle.top - y, 0, y - rectangle.bottom);
  return Math.hypot(dx, dy);
}

const isInside = (rectangle: Rectangle, room: Rectangle): boolean =>
  rectangle.left >= room.left &&
  rectangle.right <= room.right &&
  rectangle.top >= room.top &&
  rectangle.bottom <= room.bottom;

/** The rectangle a wrapped label covers, estimated wide: its widest line as bold, a line as tall as its line height. */
function labelRectangle(
  lines: readonly string[],
  size: number,
  anchor: 'start' | 'middle' | 'end',
  x: number,
  top: number,
): Rectangle {
  const width = Math.max(...lines.map((line) => textWidth(line, size * BOLD_SLACK)));
  const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
  return { left, right: left + width, top, bottom: top + lines.length * size * LABEL_LINE_HEIGHT };
}

/**
 * Which side of its node a label takes. At the top and bottom a label stacks above or below its node, or, when
 * `beside` (a short, wide box has no height for the stacks), sits at the node's right at the top and left at the bottom,
 * the way the ring runs.
 */
const sideOf = (angle: number, beside: boolean): Side => {
  const across = Math.cos(angle);
  if (across > SIDE_THRESHOLD) return 'right';
  if (across < -SIDE_THRESHOLD) return 'left';
  const top = Math.sin(angle) < 0;
  if (beside) return top ? 'right' : 'left';
  return top ? 'above' : 'below';
};

/** How much room a label on this side of a node has to wrap in. */
function roomForLabel(side: Side, x: number, metrics: Metrics, room: Rectangle): number {
  const reach = metrics.nodeRadius + metrics.gap;
  const width =
    side === 'right'
      ? room.right - (x + reach)
      : side === 'left'
        ? x - reach - room.left
        : 2 * Math.min(x - room.left, room.right - x);
  return Math.min(width, metrics.size * LABEL_WIDTH_IN_SIZES);
}

/** A node's label, outside the ring: beside the node on the left and right halves, above or below at the top and bottom. */
function placeLabel(item: PictureItem, angle: number, ring: Ring, metrics: Metrics, room: Rectangle, beside: boolean) {
  const x = ring.centreX + ring.radius * Math.cos(angle);
  const y = ring.centreY + ring.radius * Math.sin(angle);
  const side = sideOf(angle, beside);
  const lines = wrapText(
    item.label,
    roomForLabel(side, x, metrics, room),
    metrics.size * BOLD_SLACK,
    MAX_LABEL_LINES + 1,
  );
  const block = lines.length * metrics.size * LABEL_LINE_HEIGHT;
  const reach = metrics.nodeRadius + metrics.gap;
  const anchor = side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle';
  const labelX = side === 'right' ? x + reach : side === 'left' ? x - reach : x;
  const top = side === 'above' ? y - reach - block : side === 'below' ? y + reach : y - block / 2;
  const label: PlacedLabel = {
    side,
    x: labelX,
    y: top + metrics.size * 0.9,
    lines,
    rectangle: labelRectangle(lines, metrics.size, anchor, labelX, top),
  };
  return { angle, x, y, label, tooLong: lines.length > MAX_LABEL_LINES };
}

/**
 * The centre: a circle in the middle with its name under it, the pair centred on the ring and kept inside the ring's
 * own circle. The name is never inside the circle: a meaning colour (a warm Sun) would swallow it.
 */
function placeCentre(item: PictureItem, ring: Ring, metrics: Metrics): { centre: PlacedCentre; inside: boolean } {
  const space = ring.radius - metrics.nodeRadius - 2 * CLEARANCE;
  const lines = wrapText(item.label, Math.max(space * 1.4, metrics.size * 4), metrics.size * BOLD_SLACK, 2);
  const block = lines.length * metrics.size * LABEL_LINE_HEIGHT;
  // The circle shrinks, down to a dot, until the circle and its name fit inside the ring.
  let radius = Math.min(Math.max(ring.radius * 0.3, MIN_CENTRE_RADIUS), MAX_CENTRE_RADIUS);
  for (;;) {
    const centre = centreAt(ring, metrics, lines, block, radius);
    const inside = centreReach(centre, ring) <= space;
    if (inside || radius <= MIN_CENTRE_RADIUS) return { centre, inside };
    radius = Math.max(MIN_CENTRE_RADIUS, radius - 2);
  }
}

/** The circle and its name under it, as a pair centred on the ring. */
function centreAt(ring: Ring, metrics: Metrics, lines: readonly string[], block: number, radius: number): PlacedCentre {
  const y = ring.centreY - (2 * radius + metrics.gap + block) / 2 + radius;
  const top = y + radius + metrics.gap;
  const rectangle = labelRectangle(lines, metrics.size, 'middle', ring.centreX, top);
  return { x: ring.centreX, y, radius, lines, baseline: top + metrics.size * 0.9, rectangle };
}

/** How far the centre's circle and name reach from the ring's centre. */
function centreReach(centre: PlacedCentre, ring: Ring): number {
  const { rectangle } = centre;
  const across = Math.max(Math.abs(rectangle.left - ring.centreX), Math.abs(rectangle.right - ring.centreX));
  const down = Math.max(Math.abs(rectangle.top - ring.centreY), Math.abs(rectangle.bottom - ring.centreY));
  return Math.max(Math.hypot(across, down), Math.abs(centre.y - ring.centreY) + centre.radius);
}

/** Whether the labels fit: inside the room, clear of each other, of every node and of the ring. */
function labelsFit(
  items: readonly PlacedItem[],
  tooLong: boolean,
  ring: Ring,
  metrics: Metrics,
  room: Rectangle,
): boolean {
  if (tooLong) return false;
  const rectangles = items.map((item) => item.label.rectangle);
  return rectangles.every(
    (rectangle, index) =>
      isInside(rectangle, room) &&
      distanceToRectangle(rectangle, ring.centreX, ring.centreY) >= ring.radius + 2 * CLEARANCE &&
      items.every(
        (other, otherIndex) =>
          otherIndex === index ||
          (!rectanglesTouch(rectangle, other.label.rectangle) &&
            distanceToRectangle(rectangle, other.x, other.y) > metrics.nodeRadius + CLEARANCE),
      ),
  );
}

function placeRing(picture: CyclePicture, ring: Ring, metrics: Metrics, room: Rectangle, beside: boolean): Placement {
  const count = picture.items.length;
  const placed = picture.items.map((item, index) =>
    placeLabel(item, -Math.PI / 2 + (2 * Math.PI * index) / count, ring, metrics, room, beside),
  );
  const items = placed.map(({ angle, x, y, label }): PlacedItem => ({ angle, x, y, label }));
  const centred = picture.centre === undefined ? undefined : placeCentre(picture.centre, ring, metrics);
  const fits =
    labelsFit(
      items,
      placed.some((item) => item.tooLong),
      ring,
      metrics,
      room,
    ) &&
    (centred === undefined || centred.inside);
  return { items, centre: centred?.centre, fits };
}

/** The metrics for a label size: a node is about half a line high, with a gap to its label. */
function metricsFor(size: number): Metrics {
  return { size, nodeRadius: Math.min(9, Math.max(4, size * 0.5)) * 1.35, gap: Math.max(4, size * 0.35) };
}

interface Fitted {
  readonly ring: Ring;
  readonly metrics: Metrics;
  readonly placement: Placement;
}

/**
 * The largest label size up to the reader's, and at that size the largest ring, where every label fits and each arc
 * between nodes is at least `minArc` long.
 */
function searchRing(picture: CyclePicture, box: PictureBox, minArc: number): Fitted | undefined {
  const room = inner(box);
  const bounds: Rectangle = { left: room.x, top: room.y, right: room.x + room.width, bottom: room.y + room.height };
  const count = picture.items.length;
  for (let size = labelSize(box.height, box.textScale); size >= SMALLEST_LABEL; size -= 1) {
    const metrics = metricsFor(size);
    const largest = Math.min(room.width, room.height) / 2 - metrics.nodeRadius;
    const smallest = (minArc + 2 * (metrics.nodeRadius + CLEARANCE)) / ((2 * Math.PI) / count);
    for (let radius = largest; radius >= smallest; radius -= 2) {
      const ring = { centreX: box.width / 2, centreY: box.height / 2, radius };
      for (const beside of [false, true]) {
        const placement = placeRing(picture, ring, metrics, bounds, beside);
        if (placement.fits) return { ring, metrics, placement };
      }
    }
  }
  return undefined;
}

/**
 * The ring and its labels. Arrows get room first; a box too narrow for that (a tall one with a long ring) accepts
 * shorter arcs, and one too tight for any gets the smallest label on a middling ring rather than nothing.
 */
function fitRing(picture: CyclePicture, box: PictureBox): Fitted {
  const found = [MIN_ARC, MIN_ARC / 2, 0].reduce<Fitted | undefined>(
    (best, minArc) => best ?? searchRing(picture, box, minArc),
    undefined,
  );
  if (found !== undefined) return found;
  const room = inner(box);
  const metrics = metricsFor(SMALLEST_LABEL);
  const ring = {
    centreX: box.width / 2,
    centreY: box.height / 2,
    radius: (Math.min(room.width, room.height) / 2 - metrics.nodeRadius) * 0.8,
  };
  const bounds: Rectangle = { left: room.x, top: room.y, right: room.x + room.width, bottom: room.y + room.height };
  return { ring, metrics, placement: placeRing(picture, ring, metrics, bounds, false) };
}

/** An arc from one node's edge to the next node's edge, along the ring, with its head at the next node. */
function arcBetween(
  picture: CyclePicture,
  index: number,
  ring: Ring,
  metrics: Metrics,
  state: PictureState,
): PictureShape {
  const count = picture.items.length;
  const from = picture.items[index] as PictureItem;
  const nextIndex = (index + 1) % count;
  const to = picture.items[nextIndex] as PictureItem;
  const step = (2 * Math.PI) / count;
  const start = -Math.PI / 2 + step * index;
  // Each end stops short of its node by the node's radius, seen from the centre.
  const trim = (metrics.nodeRadius + CLEARANCE) / ring.radius;
  const reached = state.upTo === undefined || (index < state.upTo && nextIndex < state.upTo);
  const touchesLit = isLit(state, from.id) || isLit(state, to.id);
  const faded = state.lit !== undefined && !touchesLit;
  return {
    type: 'arc',
    key: `arc-${from.id}-${to.id}`,
    part: to.id,
    cx: ring.centreX,
    cy: ring.centreY,
    r: ring.radius,
    from: start + trim,
    to: start + step - trim,
    stroke: touchesLit ? 'ink' : 'ink2',
    strokeWidth: touchesLit ? 2 : 1.5,
    arrow: true,
    opacity: !reached ? 0 : faded ? RECEDED : 1,
  };
}

function nodeShapes(
  item: PictureItem,
  index: number,
  placed: PlacedItem,
  metrics: Metrics,
  state: PictureState,
): PictureShape[] {
  const lit = isLit(state, item.id);
  const opacity = itemOpacity(state, item.id, index);
  const tone = toneRole(item.tone);
  return [
    {
      type: 'circle',
      key: `${item.id}-node`,
      part: item.id,
      cx: placed.x,
      cy: placed.y,
      r: lit ? metrics.nodeRadius : metrics.nodeRadius / 1.35,
      fill: lit ? (item.tone ?? 'mark') : (item.tone ?? 'raised'),
      stroke: lit ? 'mark' : tone,
      strokeWidth: lit ? 3 : 1.5,
      opacity,
    },
    labelShape({
      key: `${item.id}-label`,
      part: item.id,
      x: placed.label.x,
      y: placed.label.y,
      lines: placed.label.lines,
      size: metrics.size,
      bold: lit,
      anchor: placed.label.side === 'right' ? 'start' : placed.label.side === 'left' ? 'end' : 'middle',
      opacity,
    }),
  ];
}

function centreShapes(item: PictureItem, centre: PlacedCentre, metrics: Metrics, state: PictureState): PictureShape[] {
  const lit = isLit(state, item.id);
  const opacity = itemOpacity(state, item.id);
  return [
    {
      type: 'circle',
      key: `${item.id}-node`,
      part: item.id,
      cx: centre.x,
      cy: centre.y,
      r: centre.radius,
      fill: item.tone ?? 'raised',
      stroke: lit ? 'mark' : toneRole(item.tone),
      strokeWidth: lit ? 3 : 1.5,
      opacity,
    },
    labelShape({
      key: `${item.id}-label`,
      part: item.id,
      x: centre.x,
      y: centre.baseline,
      lines: centre.lines,
      size: metrics.size,
      bold: lit,
      anchor: 'middle',
      opacity,
    }),
  ];
}

/**
 * Items evenly on a ring, the first at the top and the rest clockwise, an arrowed arc from each to the next and the last
 * back to the first, an optional centre inside. Labels sit outside the ring and are checked not to touch each other.
 * `upTo` fades the items not yet reached and the arcs touching them; they stay in the scene so a later state glides them in.
 */
export function layoutCycle(picture: CyclePicture, state: PictureState, box: PictureBox): PictureScene {
  const { ring, metrics, placement } = fitRing(picture, box);
  const arcs = picture.items.map((_, index) => arcBetween(picture, index, ring, metrics, state));
  const nodes = picture.items.flatMap((item, index) =>
    nodeShapes(item, index, placement.items[index] as PlacedItem, metrics, state),
  );
  const centre =
    picture.centre === undefined || placement.centre === undefined
      ? []
      : centreShapes(picture.centre, placement.centre, metrics, state);
  return { pictureId: picture.id, width: box.width, height: box.height, shapes: [...arcs, ...centre, ...nodes] };
}
