import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, RectShape, TextShape } from '../scene';
import { RECEDED } from './common';
import { layoutGrid } from './grid';
import { hasUniqueKeys, keysOf, overlappingTexts, shapesOutside, TEST_BOXES, TEXT_SCALES } from './scene-check';

type GridPicture = PictureOfKind<'grid'>;

const COLUMN_LABELS = ['The reason is dead', 'The reason is alive', 'Before the change'];
const ROW_LABELS = ['Ask first', 'Tear it down first', 'Cost to the town', 'Who notices'];
const TEXTS = ['An afternoon', 'Nothing', 'A week', 'Few people', 'Everyone', 'High'];

/** A grid of `columns` × `rows`; the cell at the second row and second column (or the last) is large and warm. */
function gridOf(columns: number, rows: number): GridPicture {
  const large = `r${Math.min(2, rows)}c${Math.min(2, columns)}`;
  return {
    id: 'costs',
    kind: 'grid',
    title: 'What each choice costs',
    columns: COLUMN_LABELS.slice(0, columns).map((label, index) => ({ id: `c${index + 1}`, label })),
    rows: ROW_LABELS.slice(0, rows).map((label, index) => ({ id: `r${index + 1}`, label })),
    cells: Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => {
        const id = `r${row + 1}c${column + 1}`;
        return {
          id,
          row: `r${row + 1}`,
          column: `c${column + 1}`,
          text: TEXTS[(row + column) % TEXTS.length] ?? 'Nothing',
          ...(id === large ? { size: 'large' as const, tone: 'warm' as const } : {}),
        };
      }),
    ).flat(),
  };
}

const boxOf = (size: Omit<PictureBox, 'textScale'>, textScale: number): PictureBox => ({ ...size, textScale });
const named = <Shape extends { key: string }>(scene: PictureScene, key: string): Shape => {
  const found = scene.shapes.find((shape) => shape.key === key);
  if (found === undefined) throw new Error(`no shape ${key}`);
  return found as unknown as Shape;
};
const opacityOf = (scene: PictureScene, key: string): number =>
  named<{ key: string; opacity: number }>(scene, key).opacity;

const SHAPES = [
  [1, 1],
  [2, 2],
  [3, 4],
] as const;
const CASES = TEST_BOXES.flatMap((size) =>
  TEXT_SCALES.flatMap((scale) =>
    SHAPES.map(([columns, rows]) => ({
      box: boxOf(size, scale),
      picture: gridOf(columns, rows),
      name: `${size.width}x${size.height} at ${scale * 100}%, ${columns} x ${rows}`,
    })),
  ),
);

describe('layoutGrid', () => {
  it.each(CASES)('keeps every shape inside the box and no text over text: $name', ({ box, picture }) => {
    const scene = layoutGrid(picture, {}, box);
    expect(shapesOutside(scene)).toEqual([]);
    expect(overlappingTexts(scene)).toEqual([]);
    expect(hasUniqueKeys(scene)).toBe(true);
  });

  it.each(CASES)('keeps the same keys in every state: $name', ({ box, picture }) => {
    const first = picture.rows[0]?.id ?? '';
    const states: PictureState[] = [{}, { upTo: 1 }, { lit: [first] }, { lit: ['r1c1'], upTo: 1 }];
    const [whole, ...others] = states.map((state) => layoutGrid(picture, state, box));
    for (const scene of others) expect(keysOf(scene)).toEqual(keysOf(whole as PictureScene));
  });

  it('draws the same scene for the same input', () => {
    const box = boxOf(TEST_BOXES[0] as PictureBox, 1);
    const picture = gridOf(3, 4);
    expect(layoutGrid(picture, { lit: ['r2c2'] }, box)).toEqual(layoutGrid(picture, { lit: ['r2c2'] }, box));
  });

  it('draws every cell as a raised rectangle with its words inside it, with its part set', () => {
    const scene = layoutGrid(gridOf(2, 2), {}, boxOf(TEST_BOXES[1] as PictureBox, 1));
    for (const id of ['r1c1', 'r1c2', 'r2c1', 'r2c2']) {
      const rect = named<RectShape>(scene, `cell-${id}`);
      const text = named<TextShape>(scene, `cell-${id}-text`);
      expect(rect.fill).toBe('raised');
      expect(rect.part).toBe(id);
      expect(text.part).toBe(id);
      expect(text.x).toBeCloseTo(rect.x + rect.width / 2);
      expect(text.anchor).toBe('middle');
    }
    expect(named<TextShape>(scene, 'column-c1').part).toBe('c1');
    expect(named<TextShape>(scene, 'row-r2').part).toBe('r2');
    expect(named<TextShape>(scene, 'row-r1').fill).toBe('ink2');
  });

  it.each(CASES.filter(({ picture }) => picture.cells.length > 1))(
    'sets a large cell bigger, bolder and heavier than a small one: $name',
    ({ box, picture }) => {
      const scene = layoutGrid(picture, {}, box);
      const large = named<TextShape>(scene, 'cell-r2c2-text');
      const small = named<TextShape>(scene, 'cell-r1c1-text');
      expect(large.size).toBeGreaterThan(small.size);
      expect(large.weight).toBe('bold');
      expect(small.weight).toBe('regular');
      expect(named<RectShape>(scene, 'cell-r2c2').strokeWidth).toBeGreaterThan(
        named<RectShape>(scene, 'cell-r1c1').strokeWidth,
      );
    },
  );

  it('draws a toned cell with its tone as the stroke, and a large one with its tone in the words', () => {
    const scene = layoutGrid(gridOf(2, 2), {}, boxOf(TEST_BOXES[1] as PictureBox, 1));
    expect(named<RectShape>(scene, 'cell-r2c2').stroke).toBe('warm');
    expect(named<TextShape>(scene, 'cell-r2c2-text').fill).toBe('warm');
    expect(named<RectShape>(scene, 'cell-r1c1').stroke).toBe('rule');
  });

  it('draws a lit cell with the mark stroke, thicker, and recedes everything else', () => {
    const picture = gridOf(2, 2);
    const box = boxOf(TEST_BOXES[1] as PictureBox, 1);
    const plain = layoutGrid(picture, {}, box);
    const scene = layoutGrid(picture, { lit: ['r1c2'] }, box);
    const lit = named<RectShape>(scene, 'cell-r1c2');
    expect(lit.stroke).toBe('mark');
    expect(lit.strokeWidth).toBeGreaterThan(named<RectShape>(plain, 'cell-r1c2').strokeWidth);
    expect(lit.opacity).toBe(1);
    expect(opacityOf(scene, 'cell-r2c1')).toBe(RECEDED);
    expect(opacityOf(scene, 'cell-r2c1-text')).toBe(RECEDED);
    expect(opacityOf(scene, 'row-r2')).toBe(RECEDED);
    expect(opacityOf(scene, 'column-c1')).toBe(RECEDED);
    // The headings that name the lit cell stay clear, though only a lit heading takes the mark colour.
    expect(opacityOf(scene, 'row-r1')).toBe(1);
    expect(named<TextShape>(scene, 'row-r1').fill).toBe('ink2');
  });

  it('lights every cell of a lit row or column, and its heading', () => {
    const picture = gridOf(3, 2);
    const box = boxOf(TEST_BOXES[2] as PictureBox, 1);
    const row = layoutGrid(picture, { lit: ['r1'] }, box);
    for (const id of ['r1c1', 'r1c2', 'r1c3']) {
      expect(named<RectShape>(row, `cell-${id}`).stroke).toBe('mark');
      expect(opacityOf(row, `cell-${id}`)).toBe(1);
    }
    expect(named<TextShape>(row, 'row-r1').fill).toBe('mark');
    expect(opacityOf(row, 'cell-r2c1')).toBe(RECEDED);
    const column = layoutGrid(picture, { lit: ['c2'] }, box);
    expect(named<RectShape>(column, 'cell-r1c2').stroke).toBe('mark');
    expect(named<RectShape>(column, 'cell-r2c2').stroke).toBe('mark');
    expect(named<TextShape>(column, 'column-c2').fill).toBe('mark');
    expect(opacityOf(column, 'cell-r1c1')).toBe(RECEDED);
  });

  it('hides the rows past upTo at opacity 0, cells and heading both, and keeps their keys', () => {
    const picture = gridOf(2, 3);
    const box = boxOf(TEST_BOXES[2] as PictureBox, 1);
    const scene = layoutGrid(picture, { upTo: 1 }, box);
    for (const key of ['row-r1', 'cell-r1c1', 'cell-r1c2-text']) expect(opacityOf(scene, key)).toBe(1);
    for (const key of ['row-r2', 'row-r3', 'cell-r2c1', 'cell-r3c2', 'cell-r3c2-text'])
      expect(opacityOf(scene, key)).toBe(0);
    const whole = layoutGrid(picture, {}, box);
    expect(named<RectShape>(scene, 'cell-r3c2').y).toBe(named<RectShape>(whole, 'cell-r3c2').y);
  });

  it('leaves a position with no cell empty', () => {
    const picture = gridOf(2, 2);
    const sparse: GridPicture = { ...picture, cells: picture.cells.filter((cell) => cell.id !== 'r1c2') };
    const scene = layoutGrid(sparse, {}, boxOf(TEST_BOXES[1] as PictureBox, 1));
    expect(scene.shapes.some((shape) => shape.key.startsWith('cell-r1c2'))).toBe(false);
    expect(scene.shapes.filter((shape) => shape.key.startsWith('cell-'))).toHaveLength(6);
  });

  it('puts the row labels above their rows when beside them would squeeze the cells under 60 px', () => {
    const picture = gridOf(3, 4);
    const tall = layoutGrid(picture, {}, { width: 260, height: 400, textScale: 1 });
    const cell = named<RectShape>(tall, 'cell-r1c1');
    const label = named<TextShape>(tall, 'row-r2');
    expect(cell.width).toBeGreaterThanOrEqual(60);
    expect(label.x).toBe(cell.x);
    expect(label.y).toBeLessThan(named<RectShape>(tall, 'cell-r2c1').y);
    expect(shapesOutside(tall)).toEqual([]);
    expect(overlappingTexts(tall)).toEqual([]);
    const wide = layoutGrid(picture, {}, { width: 560, height: 380, textScale: 1 });
    expect(named<TextShape>(wide, 'row-r2').x).toBeLessThan(named<RectShape>(wide, 'cell-r2c1').x);
  });

  it('gives the owner’s example: three small costs and one huge one', () => {
    const picture = gridOf(2, 2);
    const scene = layoutGrid(picture, {}, boxOf(TEST_BOXES[1] as PictureBox, 1));
    const sizes = picture.cells.map((cell) => named<TextShape>(scene, `cell-${cell.id}-text`).size);
    expect(Math.max(...sizes)).toBeGreaterThan(1.25 * Math.min(...sizes));
    expect(sizes.filter((size) => size === Math.max(...sizes))).toHaveLength(1);
  });
});
