import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { LineShape, PictureBox, PictureScene, RectShape, TextShape } from '../scene';
import { RECEDED } from './common';
import { layoutFlow } from './flow';
import {
  boundsOverlap,
  hasUniqueKeys,
  keysOf,
  overlappingTexts,
  shapesOutside,
  TEST_BOXES,
  TEXT_SCALES,
  textBounds,
} from './scene-check';

type FlowPicture = PictureOfKind<'flow'>;

const LABELS = [
  'Light reaches the leaf',
  'Chlorophyll absorbs it',
  'Water is split',
  'Sugar is made',
  'Sugar travels to the root',
  'Stored as starch',
];

/** A flow of `count` steps; the fourth is warm, so a tone is drawn too. */
function flowOf(count: number, labels: readonly string[] = LABELS): FlowPicture {
  return {
    id: 'photosynthesis',
    kind: 'flow',
    title: 'Photosynthesis',
    steps: labels.slice(0, count).map((label, index) => ({
      id: `step-${index + 1}`,
      label,
      ...(index === 3 ? { tone: 'warm' as const } : {}),
    })),
  };
}

const boxOf = (size: Omit<PictureBox, 'textScale'>, textScale: number): PictureBox => ({ ...size, textScale });
const rectsOf = (scene: PictureScene): RectShape[] =>
  scene.shapes.filter((shape): shape is RectShape => shape.type === 'rect');
const arrowsOf = (scene: PictureScene): LineShape[] =>
  scene.shapes.filter((shape): shape is LineShape => shape.type === 'line');
const textsOf = (scene: PictureScene): TextShape[] =>
  scene.shapes.filter((shape): shape is TextShape => shape.type === 'text');
const named = <Shape extends { key: string }>(shapes: readonly Shape[], key: string): Shape => {
  const found = shapes.find((shape) => shape.key === key);
  if (found === undefined) throw new Error(`no shape ${key}`);
  return found;
};

const CASES = TEST_BOXES.flatMap((size) =>
  TEXT_SCALES.flatMap((scale) =>
    [2, 4, 6].map((count) => ({
      size,
      scale,
      count,
      name: `${size.width}x${size.height} at ${scale * 100}%, ${count} steps`,
    })),
  ),
);

describe('layoutFlow', () => {
  describe.each(CASES)('$name', ({ size, scale, count }) => {
    const scene = layoutFlow(flowOf(count), {}, boxOf(size, scale));

    it('keeps every shape inside the box', () => {
      expect(shapesOutside(scene)).toEqual([]);
    });

    it('never lets two labels overlap', () => {
      expect(overlappingTexts(scene)).toEqual([]);
    });

    it('keeps each label inside its own step', () => {
      for (const step of flowOf(count).steps) {
        const box = named(rectsOf(scene), `${step.id}-box`);
        const label = named(textsOf(scene), `${step.id}-label`);
        const bounds = textBounds(label);
        expect(bounds.left).toBeGreaterThanOrEqual(box.x);
        expect(bounds.right).toBeLessThanOrEqual(box.x + box.width);
        expect(bounds.top).toBeGreaterThanOrEqual(box.y);
        expect(bounds.bottom).toBeLessThanOrEqual(box.y + box.height);
      }
    });

    it('keeps steps apart and the arrows clear of every label', () => {
      const boxes = rectsOf(scene).map((box) => ({
        left: box.x,
        right: box.x + box.width,
        top: box.y,
        bottom: box.y + box.height,
      }));
      boxes.forEach((first, index) =>
        boxes.slice(index + 1).forEach((second) => expect(boundsOverlap(first, second)).toBe(false)),
      );
      for (const arrow of arrowsOf(scene)) {
        const reach = {
          left: Math.min(arrow.x1, arrow.x2),
          right: Math.max(arrow.x1, arrow.x2),
          top: Math.min(arrow.y1, arrow.y2),
          bottom: Math.max(arrow.y1, arrow.y2),
        };
        for (const label of textsOf(scene)) expect(boundsOverlap(reach, textBounds(label))).toBe(false);
      }
    });

    it('draws one step and label per step and an arrowed line between each pair', () => {
      expect(rectsOf(scene)).toHaveLength(count);
      expect(textsOf(scene)).toHaveLength(count);
      expect(arrowsOf(scene)).toHaveLength(count - 1);
      expect(arrowsOf(scene).every((arrow) => arrow.arrow)).toBe(true);
    });

    it('has the same unique keys in every state of the picture', () => {
      const lit = layoutFlow(flowOf(count), { upTo: 2, lit: ['step-1'] }, boxOf(size, scale));
      expect(hasUniqueKeys(scene)).toBe(true);
      expect(keysOf(lit)).toEqual(keysOf(scene));
    });

    it('is the same scene for the same input', () => {
      expect(layoutFlow(flowOf(count), {}, boxOf(size, scale))).toEqual(scene);
    });
  });

  describe('arrangement', () => {
    it('lays a wide box in one row, left to right', () => {
      const scene = layoutFlow(flowOf(3), {}, boxOf({ width: 560, height: 380 }, 1));
      const boxes = rectsOf(scene);
      expect(new Set(boxes.map((box) => box.y)).size).toBe(1);
      expect(boxes.map((box) => box.x)).toEqual([...boxes.map((box) => box.x)].sort((a, b) => a - b));
      expect(arrowsOf(scene).every((arrow) => arrow.y1 === arrow.y2 && arrow.x2 > arrow.x1)).toBe(true);
    });

    it('opens six steps into two rows of three at 560 x 380, where one row would be thin', () => {
      const scene = layoutFlow(flowOf(6), {}, boxOf({ width: 560, height: 380 }, 1));
      const boxes = rectsOf(scene);
      expect(new Set(boxes.map((box) => box.y)).size).toBe(2);
      expect(boxes.filter((box) => box.y === boxes[0]?.y)).toHaveLength(3);
    });

    it('keeps two and three steps in one row at 560 x 380', () => {
      for (const count of [2, 3]) {
        const scene = layoutFlow(flowOf(count), {}, boxOf({ width: 560, height: 380 }, 1));
        expect(new Set(rectsOf(scene).map((box) => box.y)).size).toBe(1);
      }
    });

    it('lays a tall box in one column, top to bottom', () => {
      const scene = layoutFlow(flowOf(4), {}, boxOf({ width: 200, height: 380 }, 1));
      const boxes = rectsOf(scene);
      expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
      expect(boxes.map((box) => box.y)).toEqual([...boxes.map((box) => box.y)].sort((a, b) => a - b));
      expect(arrowsOf(scene).every((arrow) => arrow.x1 === arrow.x2 && arrow.y2 > arrow.y1)).toBe(true);
    });

    it('wraps steps that would be under 70 px wide into two rows', () => {
      const scene = layoutFlow(flowOf(6), {}, boxOf({ width: 320, height: 190 }, 1));
      expect(new Set(rectsOf(scene).map((box) => box.y)).size).toBe(2);
      expect(rectsOf(scene).every((box) => box.width >= 70)).toBe(true);
    });

    it('turns round at the end of a row, so the arrow between rows is a short drop', () => {
      const scene = layoutFlow(flowOf(6), {}, boxOf({ width: 320, height: 190 }, 1));
      const drop = named(arrowsOf(scene), 'arrow-step-3-step-4');
      expect(drop.x1).toBe(drop.x2);
      expect(drop.y2).toBeGreaterThan(drop.y1);
      expect(named(arrowsOf(scene), 'arrow-step-4-step-5').x2).toBeLessThan(
        named(arrowsOf(scene), 'arrow-step-4-step-5').x1,
      );
    });

    it('wraps long labels and shrinks them only when a word will not fit', () => {
      const long = ['Photosynthesis begins at dawn', 'Electrons are excited', 'Plastoquinone is reduced'];
      const small = layoutFlow(flowOf(3, long), {}, boxOf({ width: 320, height: 190 }, 1));
      expect(shapesOutside(small)).toEqual([]);
      expect(Math.min(...textsOf(small).map((text) => text.size))).toBeGreaterThanOrEqual(9);
    });
  });

  describe('states', () => {
    const box = boxOf({ width: 390, height: 287 }, 1);
    const opacityOf = (scene: PictureScene, key: string): number => named(scene.shapes, key).opacity;

    it('draws everything at full strength with an empty state', () => {
      expect(layoutFlow(flowOf(4), {}, box).shapes.every((shape) => shape.opacity === 1)).toBe(true);
    });

    it('hides the steps after upTo and the arrows into them, keeping them in the scene', () => {
      const scene = layoutFlow(flowOf(5), { upTo: 2 }, box);
      expect(
        ['step-1-box', 'step-1-label', 'step-2-box', 'step-2-label', 'arrow-step-1-step-2'].map((key) =>
          opacityOf(scene, key),
        ),
      ).toEqual([1, 1, 1, 1, 1]);
      for (const key of ['step-3-box', 'step-3-label', 'step-5-box', 'arrow-step-2-step-3', 'arrow-step-4-step-5'])
        expect(opacityOf(scene, key)).toBe(0);
    });

    it('shows a later state where an earlier one hid a step, in the same place', () => {
      const early = layoutFlow(flowOf(5), { upTo: 2 }, box);
      const late = layoutFlow(flowOf(5), { upTo: 5 }, box);
      expect(named(rectsOf(early), 'step-4-box').x).toBe(named(rectsOf(late), 'step-4-box').x);
      expect(opacityOf(late, 'step-4-box')).toBe(1);
    });

    it('draws a lit step in the mark colour, thicker, with a bold label, and recedes the rest', () => {
      const scene = layoutFlow(flowOf(4), { lit: ['step-2'] }, box);
      const lit = named(rectsOf(scene), 'step-2-box');
      const other = named(rectsOf(scene), 'step-1-box');
      expect(lit.stroke).toBe('mark');
      expect(lit.strokeWidth).toBeGreaterThan(other.strokeWidth);
      expect(lit.opacity).toBe(1);
      expect(named(textsOf(scene), 'step-2-label').weight).toBe('bold');
      expect(named(textsOf(scene), 'step-2-label').opacity).toBe(1);
      expect(other.opacity).toBe(RECEDED);
      expect(named(textsOf(scene), 'step-1-label')).toMatchObject({ weight: 'regular', opacity: RECEDED });
    });

    it('keeps a lit step inside its box at the same size as an unlit one', () => {
      const unlit = layoutFlow(flowOf(4), {}, box);
      const lit = layoutFlow(flowOf(4), { lit: ['step-1', 'step-2', 'step-3', 'step-4'] }, box);
      expect(shapesOutside(lit)).toEqual([]);
      expect(textsOf(lit).map((text) => text.lines)).toEqual(textsOf(unlit).map((text) => text.lines));
    });

    it('draws an unlit step in its tone, or in ink without one', () => {
      const scene = layoutFlow(flowOf(4), {}, box);
      expect(named(rectsOf(scene), 'step-4-box').stroke).toBe('warm');
      expect(named(rectsOf(scene), 'step-1-box').stroke).toBe('ink');
      expect(rectsOf(scene).every((shape) => shape.fill === 'raised')).toBe(true);
    });

    it('draws arrows in ink or ink2, strongest where they touch a lit step', () => {
      const state: PictureState = { lit: ['step-2'] };
      const scene = layoutFlow(flowOf(4), state, box);
      expect(arrowsOf(scene).every((arrow) => arrow.stroke === 'ink' || arrow.stroke === 'ink2')).toBe(true);
      expect(opacityOf(scene, 'arrow-step-1-step-2')).toBe(1);
      expect(opacityOf(scene, 'arrow-step-2-step-3')).toBe(1);
      expect(opacityOf(scene, 'arrow-step-3-step-4')).toBe(RECEDED);
    });

    it('names each part by the step it draws', () => {
      const scene = layoutFlow(flowOf(3), {}, box);
      expect(named(scene.shapes, 'step-2-box').part).toBe('step-2');
      expect(named(scene.shapes, 'step-2-label').part).toBe('step-2');
    });

    it('draws only with roles, never a colour', () => {
      const roles = new Set(['ink', 'ink2', 'rule', 'ground', 'raised', 'warm', 'cool', 'mark', 'none']);
      for (const shape of layoutFlow(flowOf(4), { lit: ['step-1'] }, box).shapes) {
        const used =
          shape.type === 'text'
            ? [shape.fill]
            : shape.type === 'line' || shape.type === 'arc'
              ? [shape.stroke]
              : [shape.fill, shape.stroke];
        for (const role of used) expect(roles.has(role)).toBe(true);
      }
    });
  });
});
