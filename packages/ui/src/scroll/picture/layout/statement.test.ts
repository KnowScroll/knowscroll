import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, TextShape } from '../scene';
import { RECEDED } from './common';
import {
  hasUniqueKeys,
  keysOf,
  overlappingTexts,
  shapesOutside,
  TEST_BOXES,
  TEXT_SCALES,
  textBounds,
} from './scene-check';
import { layoutStatement } from './statement';

type StatementPicture = PictureOfKind<'statement'>;

/** Words of exactly `length` characters, built from short words so a line can break between them. */
function wordsOf(length: number, seed: string): string {
  const words = ['river', 'stone', 'a', 'lantern', 'of', 'winter', 'light', 'the', 'long', 'harbour', 'wind'];
  let text = '';
  for (let index = 0; text.length < length; index += 1)
    text += `${text === '' ? '' : ' '}${words[(index + seed.length) % words.length] ?? ''}`;
  return text.slice(0, length).trimEnd().padEnd(length, 'x');
}

const QUOTE: StatementPicture = {
  id: 'quote',
  kind: 'statement',
  title: 'A quotation',
  statement: {
    form: 'quote',
    text: wordsOf(280, 'q'),
    who: wordsOf(80, 'w'),
    work: wordsOf(80, 'k'),
    year: '1855–1856',
  },
};

const NUMBER: StatementPicture = {
  id: 'number',
  kind: 'statement',
  title: 'A number',
  statement: { form: 'number', value: '23.4° of tilt', label: wordsOf(80, 'n'), tone: 'warm' },
};

const BIG_NUMBER: StatementPicture = {
  id: 'big-number',
  kind: 'statement',
  title: 'A long number',
  statement: { form: 'number', value: '1,234,567,890.12345 km', label: wordsOf(80, 'b') },
};

const LIST: StatementPicture = {
  id: 'list',
  kind: 'statement',
  title: 'A list',
  statement: {
    form: 'list',
    items: [1, 2, 3, 4, 5].map((index) => ({
      id: `item-${index}`,
      label: wordsOf(40, `i${index}`),
      ...(index === 2 ? { tone: 'cool' as const } : {}),
    })),
  },
};

const SHORT_QUOTE: StatementPicture = {
  id: 'short-quote',
  kind: 'statement',
  title: 'A short quotation',
  statement: { form: 'quote', text: 'Not all who wander are lost.', who: 'J. R. R. Tolkien' },
};

const SHORT_LIST: StatementPicture = {
  id: 'short-list',
  kind: 'statement',
  title: 'A short list',
  statement: {
    form: 'list',
    items: [
      { id: 'a', label: 'Light' },
      { id: 'b', label: 'Water' },
      { id: 'c', label: 'Air' },
    ],
  },
};

const LONG_PAIR: StatementPicture = {
  id: 'long-pair',
  kind: 'statement',
  title: 'Two long items',
  statement: {
    form: 'list',
    items: [
      { id: 'first', label: wordsOf(40, 'a') },
      { id: 'second', label: wordsOf(40, 'b') },
    ],
  },
};

const PICTURES: readonly StatementPicture[] = [QUOTE, NUMBER, BIG_NUMBER, LIST];
const boxOf = (size: Omit<PictureBox, 'textScale'>, textScale: number): PictureBox => ({ ...size, textScale });
const textsOf = (scene: PictureScene): TextShape[] =>
  scene.shapes.filter((shape): shape is TextShape => shape.type === 'text');
const named = (scene: PictureScene, key: string) => {
  const found = scene.shapes.find((shape) => shape.key === key);
  if (found === undefined) throw new Error(`no shape ${key}`);
  return found;
};

/** A state that lights something in the picture, so the lit and receded drawing is laid out too. */
const litState = (picture: StatementPicture): PictureState =>
  picture.statement.form === 'list' ? { lit: ['item-2'] } : {};

const CASES = PICTURES.flatMap((picture) =>
  TEST_BOXES.flatMap((size) =>
    TEXT_SCALES.map((scale) => ({
      picture,
      size,
      scale,
      name: `${picture.id} at ${size.width}x${size.height}, ${scale * 100}%`,
    })),
  ),
);

describe('layoutStatement at the longest content', () => {
  describe.each(CASES)('$name', ({ picture, size, scale }) => {
    const scene = layoutStatement(picture, {}, boxOf(size, scale));

    it('keeps every shape inside the box', () => {
      expect(shapesOutside(scene)).toEqual([]);
    });

    it('never lets two texts overlap', () => {
      expect(overlappingTexts(scene)).toEqual([]);
    });

    it('has the same unique keys, and the same lines, in every state of the picture', () => {
      const lit = layoutStatement(picture, litState(picture), boxOf(size, scale));
      expect(hasUniqueKeys(scene)).toBe(true);
      expect(keysOf(lit)).toEqual(keysOf(scene));
      expect(textsOf(lit).map((text) => text.lines)).toEqual(textsOf(scene).map((text) => text.lines));
      expect(shapesOutside(lit)).toEqual([]);
    });

    it('is the same scene for the same input', () => {
      expect(layoutStatement(picture, {}, boxOf(size, scale))).toEqual(scene);
    });

    it('never sets text under 9 px, and never cuts a line short with an ellipsis', () => {
      for (const text of textsOf(scene)) {
        if (text.key !== 'value') expect(text.size).toBeGreaterThanOrEqual(9);
        for (const line of text.lines) expect(line.endsWith('…')).toBe(false);
      }
    });
  });

  describe('a quotation', () => {
    it('keeps its whole text and attribution, wrapped, however long', () => {
      const scene = layoutStatement(QUOTE, {}, boxOf({ width: 320, height: 190 }, 1));
      expect(named(scene, 'quote')).toMatchObject({ type: 'text' });
      expect(
        textsOf(scene)
          .find((text) => text.key === 'quote')
          ?.lines.join(' '),
      ).toBe(`“${(QUOTE.statement as { text: string }).text}”`);
      expect(textsOf(scene).find((text) => text.key === 'by')?.lines.length ?? 0).toBeGreaterThan(1);
    });

    it('shrinks as the text grows, and stays large for a short one', () => {
      const box = boxOf({ width: 390, height: 287 }, 1);
      const long = textsOf(layoutStatement(QUOTE, {}, box)).find((text) => text.key === 'quote');
      const short = textsOf(layoutStatement(SHORT_QUOTE, {}, box)).find((text) => text.key === 'quote');
      expect(short?.size).toBe(22);
      expect(long?.size).toBeLessThan(short?.size ?? 0);
    });

    it('sets a normal quotation in one block with its attribution on a line of its own', () => {
      const scene = layoutStatement(SHORT_QUOTE, {}, boxOf({ width: 390, height: 287 }, 1));
      const by = textsOf(scene).find((text) => text.key === 'by');
      expect(by?.lines).toEqual(['— J. R. R. Tolkien']);
      expect(textBounds(by as TextShape).top).toBeGreaterThan(
        textBounds(textsOf(scene).find((text) => text.key === 'quote') as TextShape).bottom,
      );
    });
  });

  describe('a number', () => {
    it('draws the value large and the label under it, wrapped, in ink2', () => {
      const scene = layoutStatement(NUMBER, {}, boxOf({ width: 390, height: 287 }, 1));
      const value = textsOf(scene).find((text) => text.key === 'value');
      const label = textsOf(scene).find((text) => text.key === 'label');
      expect(value?.fill).toBe('warm');
      expect(label?.fill).toBe('ink2');
      expect(value?.size).toBeGreaterThan(label?.size ?? 0);
      expect(label?.lines.length).toBeGreaterThan(1);
    });
  });

  describe('a list', () => {
    it('sizes each row for the lines its label wraps to', () => {
      const scene = layoutStatement(LONG_PAIR, {}, boxOf({ width: 390, height: 287 }, 2));
      expect(shapesOutside(scene)).toEqual([]);
      expect(overlappingTexts(scene)).toEqual([]);
      const labels = textsOf(scene).filter((text) => text.key.endsWith('-label'));
      expect(labels).toHaveLength(2);
      expect(labels.every((label) => label.lines.length > 1)).toBe(true);
      // Each label's centre is its mark's: a wrapped label sits beside its own mark, in its own row.
      for (const label of labels) {
        const bounds = textBounds(label);
        const mark = named(scene, label.key.replace('-label', '-mark'));
        const middle = mark.type === 'circle' ? mark.cy : 0;
        expect(bounds.top).toBeLessThanOrEqual(middle);
        expect(bounds.bottom).toBeGreaterThanOrEqual(middle);
      }
    });

    it('keeps the rows of short labels evenly spaced and the size unchanged', () => {
      const scene = layoutStatement(SHORT_LIST, {}, boxOf({ width: 390, height: 287 }, 1));
      const baselines = textsOf(scene).map((text) => text.y);
      expect(baselines[1]! - baselines[0]!).toBeCloseTo(baselines[2]! - baselines[1]!, 5);
      for (const text of textsOf(scene)) expect(text.size).toBeCloseTo(14.4, 5);
    });

    it('marks a lit item, draws it bold, and recedes the rest', () => {
      const scene = layoutStatement(SHORT_LIST, { lit: ['b'] }, boxOf({ width: 390, height: 287 }, 1));
      expect(named(scene, 'b-mark')).toMatchObject({ fill: 'mark', opacity: 1 });
      expect(named(scene, 'b-label')).toMatchObject({ weight: 'bold', opacity: 1 });
      expect(named(scene, 'a-label')).toMatchObject({ weight: 'regular', opacity: RECEDED });
    });
  });
});
