import { processColor } from 'react-native';
import { render } from '@testing-library/react-native';
import { scrollPagePalettes } from '@knowscroll/design-tokens';
import { pictureColours } from './palette';
import { PictureSvg, textOpacity } from './picture-svg';
import { RECEDED, RECEDED_TEXT } from './layout/common';
import type { PictureScene, PictureShape } from './scene';

const light = scrollPagePalettes.light;
const colours = pictureColours({
  ground: light.paper,
  raised: light.plate,
  ink: light.ink,
  ink2: light.ink2,
  rule: light.rule,
  link: light.accentDeep,
});

interface Node {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[] | null;
}

function nodesOf(tree: unknown): Node[] {
  if (typeof tree !== 'object' || tree === null) return [];
  const node = tree as Node;
  return [node, ...(node.children ?? []).flatMap(nodesOf)];
}

/** The painted colour react-native-svg is given for a CSS colour. */
const paintOf = (colour: string) => ({ type: 0, payload: processColor(colour) });
const byType = (nodes: readonly Node[], type: string) => nodes.filter((node) => node.type === type);

const base = { part: 'dots', opacity: 1 } as const;
const SHAPES: readonly PictureShape[] = [
  {
    ...base,
    type: 'rect',
    key: 'bar',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    cornerRadius: 0,
    fill: 'cool',
    stroke: 'none',
    strokeWidth: 0,
  },
  { ...base, type: 'circle', key: 'dot', cx: 20, cy: 20, r: 4, fill: 'warm', stroke: 'none', strokeWidth: 0 },
  {
    ...base,
    type: 'line',
    key: 'line',
    x1: 0,
    y1: 30,
    x2: 40,
    y2: 30,
    stroke: 'ink',
    strokeWidth: 1,
    dashed: false,
    arrow: false,
  },
  {
    ...base,
    type: 'arc',
    key: 'arc',
    cx: 30,
    cy: 30,
    r: 10,
    from: 0,
    to: 2,
    stroke: 'ink2',
    strokeWidth: 0,
    arrow: false,
  },
  {
    ...base,
    type: 'text',
    key: 'words',
    x: 5,
    y: 50,
    lines: ['hello'],
    size: 12,
    lineHeight: 14,
    weight: 'regular',
    anchor: 'start',
    fill: 'ink',
    family: 'sans',
  },
];

const sceneOf = (shapes: readonly PictureShape[]): PictureScene => ({
  pictureId: 'p',
  width: 100,
  height: 100,
  shapes,
});

async function drawn(shapes: readonly PictureShape[], pulsing?: string) {
  const view = await render(<PictureSvg scene={sceneOf(shapes)} colours={colours} pulsing={pulsing} />);
  const nodes = nodesOf(view.toJSON());
  await view.unmount();
  return nodes;
}

describe('the pulse of a picture part', () => {
  it('draws a shape that has no stroke with a mark stroke of at least 2 px: rect, circle, line, arc', async () => {
    const nodes = await drawn(SHAPES, 'dots');
    for (const type of ['RNSVGRect', 'RNSVGCircle', 'RNSVGLine', 'RNSVGPath']) {
      const shapes = byType(nodes, type);
      expect(shapes).toHaveLength(1);
      expect(shapes[0]?.props?.['stroke']).toEqual(paintOf(colours.mark));
      expect(Number(shapes[0]?.props?.['strokeWidth'])).toBeGreaterThanOrEqual(2);
    }
  });

  it('draws a pulsed text in the mark fill, and a thicker own stroke heavier still', async () => {
    const nodes = await drawn(
      [...SHAPES.slice(0, 4).map((shape) => ({ ...shape, part: 'other' })), SHAPES[4]!],
      'dots',
    );
    expect(byType(nodes, 'RNSVGText')[0]?.props?.['fill']).toEqual(paintOf(colours.mark));
    const heavy = await drawn([{ ...(SHAPES[0] as PictureShape), strokeWidth: 3 } as PictureShape], 'dots');
    expect(Number(byType(heavy, 'RNSVGRect')[0]?.props?.['strokeWidth'])).toBeGreaterThan(3);
  });

  it('leaves the same shapes unstroked when nothing is pulsing', async () => {
    const nodes = await drawn(SHAPES);
    expect(byType(nodes, 'RNSVGRect')[0]?.props?.['strokeWidth']).toBe(0);
    expect(byType(nodes, 'RNSVGText')[0]?.props?.['fill']).toEqual(paintOf(colours.ink));
  });

  it('leaves a hidden shape hidden', async () => {
    const hidden = SHAPES.map((shape) => ({ ...shape, opacity: 0 }));
    const nodes = await drawn(hidden, 'dots');
    for (const type of ['RNSVGRect', 'RNSVGCircle', 'RNSVGLine', 'RNSVGPath', 'RNSVGText'])
      expect(byType(nodes, type)).toEqual([]);
  });

  it('does not touch another part', async () => {
    const nodes = await drawn(SHAPES, 'another-part');
    expect(byType(nodes, 'RNSVGRect')[0]?.props?.['strokeWidth']).toBe(0);
  });
});

describe('a receded part', () => {
  it('draws its text at the receded text opacity and any other shape at the opacity its layout gave', async () => {
    const receded = [SHAPES[0]!, SHAPES[4]!].map((shape) => ({ ...shape, opacity: RECEDED }));
    const nodes = await drawn(receded);
    const opacities = byType(nodes, 'RNSVGGroup')
      .map((node) => node.props?.['opacity'])
      .filter((opacity) => opacity !== undefined);
    expect(opacities).toEqual([RECEDED, RECEDED_TEXT]);
  });
});

describe('textOpacity', () => {
  it('sends 0 to 0, 1 to 1 and the receded opacity to the receded text opacity', () => {
    expect(textOpacity(0)).toBe(0);
    expect(textOpacity(1)).toBe(1);
    expect(textOpacity(RECEDED)).toBeCloseTo(RECEDED_TEXT, 12);
  });

  it('rises steadily, so a fade-in still fades', () => {
    let last = -1;
    for (let opacity = 0; opacity <= 1.0001; opacity += 0.05) {
      const next = textOpacity(Math.min(1, opacity));
      expect(next).toBeGreaterThan(last);
      last = next;
    }
  });
});
