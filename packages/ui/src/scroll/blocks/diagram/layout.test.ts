import { CANVAS_WIDTH, boxEdge, edgeEnds, layoutDiagram } from './layout';
import { describeDiagram } from './describe';
import { frameView, strokeFor } from './frame-view';
import { keepInside, targetAt, initialFrame } from './drag-model';
import { cycleDiagram, gridDiagram, layersDiagram, loadPathDiagram, weightDiagram } from '../../fixtures/blocks';

function inside(layout: ReturnType<typeof layoutDiagram>) {
  return layout.nodes.every(
    (node) =>
      node.x - node.width / 2 >= -0.5 &&
      node.x + node.width / 2 <= CANVAS_WIDTH + 0.5 &&
      node.y - node.height / 2 >= -0.5 &&
      node.y + node.height / 2 <= layout.height + 0.5,
  );
}

describe('diagram layout', () => {
  it('places every node of every layout inside the canvas, with no model-written coordinates', () => {
    for (const block of [
      loadPathDiagram('a'),
      weightDiagram('b'),
      cycleDiagram('c'),
      layersDiagram('d'),
      gridDiagram('e'),
    ]) {
      const layout = layoutDiagram(block.data);
      expect(layout.nodes).toHaveLength(block.data.nodes.length);
      expect(inside(layout)).toBe(true);
    }
  });

  it('lays a short flow out left to right on one row, in reading order', () => {
    const layout = layoutDiagram(loadPathDiagram('a').data);
    const ys = new Set(layout.nodes.map((node) => node.y));
    expect(ys.size).toBe(1);
    const xs = layout.nodes.map((node) => node.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('puts the first node of a radial layout in the middle and the others around it', () => {
    const layout = layoutDiagram(weightDiagram('b').data);
    const [hub, ...rest] = layout.nodes;
    expect(hub?.x).toBeCloseTo(CANVAS_WIDTH / 2);
    expect(hub?.id).toBe('load');
    for (const node of rest) expect(Math.hypot(node.x - (hub?.x ?? 0), node.y - (hub?.y ?? 0))).toBeGreaterThan(60);
  });

  it('puts each node of a grid layout in the cell the document names', () => {
    const layout = layoutDiagram(gridDiagram('e').data);
    const cell = CANVAS_WIDTH / 6;
    const a = layout.nodes.find((node) => node.id === 'g-a');
    const c = layout.nodes.find((node) => node.id === 'g-c');
    expect(a?.x).toBeCloseTo(0.5 * cell);
    expect(c?.x).toBeCloseTo(2.5 * cell);
    expect((a?.y ?? 0) > (c?.y ?? 0)).toBe(true);
  });

  it('draws a band per group in a layers layout, around the nodes of the group', () => {
    const layout = layoutDiagram(layersDiagram('d').data);
    expect(layout.groups.map((group) => group.id)).toEqual(['above', 'below']);
    for (const group of layout.groups) {
      for (const node of layout.nodes.filter((candidate) => candidate.group === group.id)) {
        expect(node.y - node.height / 2).toBeGreaterThanOrEqual(group.y);
        expect(node.y + node.height / 2).toBeLessThanOrEqual(group.y + group.height);
      }
    }
  });

  it('clips an edge to the boxes it joins, so arrows touch edges and not centres', () => {
    const layout = layoutDiagram(loadPathDiagram('a').data);
    const [from, to] = layout.nodes;
    if (from === undefined || to === undefined) throw new Error('two nodes');
    const ends = edgeEnds(from, to);
    expect(ends.from.x).toBeCloseTo(from.x + from.width / 2);
    expect(ends.to.x).toBeCloseTo(to.x - to.width / 2);
    expect(boxEdge(from, { x: from.x, y: from.y })).toEqual({ x: from.x, y: from.y });
  });
});

describe('diagram frames', () => {
  it('names what a frame hides, points at and re-weights, and lets the rest recede', () => {
    const data = weightDiagram('b').data;
    const view = frameView(data, 'f-left');
    expect(view.dims).toBe(true);
    expect(view.emphasis.has('e-left')).toBe(true);
    expect(view.weights.get('e-left')).toBe(0.9);
    expect(frameView(data, null).dims).toBe(false);
    expect(frameView(data, 'no-such-frame').dims).toBe(false);
  });

  it('draws weight as stroke width: heavier is thicker, never a measurement', () => {
    expect(strokeFor(0)).toBeLessThan(strokeFor(0.5));
    expect(strokeFor(0.5)).toBeLessThan(strokeFor(1));
    expect(strokeFor(undefined)).toBe(strokeFor(0.35));
  });

  it('describes the diagram in words for the current frame, leaving out what the frame hides', () => {
    const data = loadPathDiagram('a').data;
    const description = describeDiagram(data, 'f-deck');
    expect(description.nodes).toEqual(['Deck', 'Cables', 'Towers', 'Ground']);
    expect(description.connections).toEqual(['Deck → Cables', 'Cables → Towers', 'Towers → Ground']);
    const hiding = describeDiagram(
      {
        ...data,
        frames: [
          {
            ...(data.frames[0] ??
              (() => {
                throw new Error('frame');
              })()),
            hidden: ['ground'],
          },
        ],
      },
      'f-deck',
    );
    expect(hiding.nodes).not.toContain('Ground');
    expect(hiding.connections).not.toContain('Towers → Ground');
  });

  it('labels a connection and marks one without a direction', () => {
    const data = cycleDiagram('c').data;
    expect(describeDiagram(data, 'c-1').connections).toContain('Inspect → Plan (revise)');
    expect(describeDiagram(weightDiagram('b').data, 'f-mid').connections[0]).toBe('weight — Left pier');
  });
});

describe('dragging a token onto a target', () => {
  const data = weightDiagram('b').data;
  const layout = layoutDiagram(data);
  const interaction = data.interaction.kind === 'drag-to-target' ? data.interaction : null;
  if (interaction === null) throw new Error('the weight diagram drags');

  it('finds the target a token is dropped on, and none elsewhere', () => {
    const left = layout.nodes.find((node) => node.id === 'left');
    if (left === undefined) throw new Error('left');
    expect(targetAt(layout, interaction, { x: left.x, y: left.y })).toEqual({ node: 'left', frame: 'f-left' });
    expect(targetAt(layout, interaction, { x: left.x + left.width / 2 + 10, y: left.y })?.node).toBe('left');
    expect(targetAt(layout, interaction, { x: -50, y: -50 })).toBeNull();
    expect(targetAt(layout, interaction, { x: CANVAS_WIDTH / 2, y: layout.height / 2 })).toBeNull();
  });

  it('keeps a dragged token inside the canvas', () => {
    const token = layout.nodes.find((node) => node.id === 'load');
    if (token === undefined) throw new Error('token');
    const moved = keepInside(layout, token, { x: -100, y: 9999 });
    expect(moved.x).toBe(token.width / 2);
    expect(moved.y).toBe(layout.height - token.height / 2);
  });

  it('starts, and resets to, the document’s initial frame', () => {
    expect(initialFrame(interaction, 'f-left')).toBe('f-mid');
    expect(initialFrame({ kind: 'steps' }, 'f-first')).toBe('f-first');
  });
});
