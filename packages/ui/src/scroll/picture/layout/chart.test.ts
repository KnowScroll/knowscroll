import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { CircleShape, LineShape, PictureBox, PictureScene, RectShape, TextShape } from '../scene';
import { RECEDED } from './common';
import { layoutChart } from './chart';
import {
  hasUniqueKeys,
  keysOf,
  overlappingTexts,
  shapesOutside,
  TEST_BOXES,
  TEXT_SCALES,
  textBounds,
} from './scene-check';

type ChartPicture = PictureOfKind<'chart'>;

const DAYS = [
  ['30 Aug', '8'],
  ['31 Aug', '56'],
  ['1 Sep', '143'],
  ['2 Sep', '116'],
  ['3 Sep', '54'],
  ['4 Sep', '46'],
  ['5 Sep', '36'],
  ['6 Sep', '20'],
  ['7 Sep', '28'],
  ['8 Sep', '12'],
  ['9 Sep', '11'],
  ['10 Sep', '5'],
  ['11 Sep', '5'],
  ['12 Sep', '1,000'],
  ['13 Sep', '3'],
  ['14 Sep', '0'],
] as const;

/** A chart of `count` points; two of them are marked and one is warm, so marks and tones are drawn too. */
function chartOf(count: number, form: ChartPicture['form'], values: ChartPicture['values']): ChartPicture {
  const points = DAYS.slice(0, count).map(([label, value], index) => ({
    id: `p${index}`,
    label,
    value,
    ...(index === 1 ? { tone: 'warm' as const } : {}),
  }));
  const marks =
    count < 6
      ? []
      : [
          { point: 'p2', label: 'Peak' },
          { point: `p${count - 3}`, label: 'Handle removed' },
        ];
  return { id: 'attacks', kind: 'chart', title: 'Fatal attacks a day', form, unit: 'deaths', values, points, marks };
}

const boxOf = (size: Omit<PictureBox, 'textScale'>, textScale: number): PictureBox => ({ ...size, textScale });
const named = <Shape extends { key: string }>(scene: PictureScene, key: string): Shape => {
  const found = scene.shapes.find((shape) => shape.key === key);
  if (found === undefined) throw new Error(`no shape ${key}`);
  return found as unknown as Shape;
};
const opacityOf = (scene: PictureScene, key: string): number =>
  named<{ key: string; opacity: number }>(scene, key).opacity;
const has = (scene: PictureScene, key: string): boolean => scene.shapes.some((shape) => shape.key === key);

const CASES = TEST_BOXES.flatMap((size) =>
  TEXT_SCALES.flatMap((scale) =>
    [2, 6, 16].flatMap((count) =>
      (['bars', 'line'] as const).flatMap((form) =>
        (['shown', 'hidden'] as const).map((values) => ({
          box: boxOf(size, scale),
          picture: chartOf(count, form, values),
          name: `${size.width}x${size.height} at ${scale * 100}%, ${count} ${form}, values ${values}`,
        })),
      ),
    ),
  ),
);

const MIDDLE = boxOf(TEST_BOXES[1] as PictureBox, 1);

describe('layoutChart', () => {
  it.each(CASES)('keeps every shape inside the box and no text over text: $name', ({ box, picture }) => {
    const scene = layoutChart(picture, {}, box);
    expect(shapesOutside(scene)).toEqual([]);
    expect(overlappingTexts(scene)).toEqual([]);
    expect(hasUniqueKeys(scene)).toBe(true);
  });

  it.each(CASES)('keeps the same keys in every state: $name', ({ box, picture }) => {
    const states: PictureState[] = [{}, { upTo: 2 }, { lit: ['p0'] }, { lit: ['p1', 'p0'], upTo: 2 }];
    const [whole, ...others] = states.map((state) => layoutChart(picture, state, box));
    for (const scene of others) expect(keysOf(scene)).toEqual(keysOf(whole as PictureScene));
  });

  it('draws the same scene for the same input', () => {
    const picture = chartOf(16, 'line', 'shown');
    expect(layoutChart(picture, { lit: ['p3'] }, MIDDLE)).toEqual(layoutChart(picture, { lit: ['p3'] }, MIDDLE));
  });

  it('draws a baseline in rule under the bars', () => {
    const scene = layoutChart(chartOf(6, 'bars', 'shown'), {}, MIDDLE);
    const baseline = named<LineShape>(scene, 'baseline');
    expect(baseline.stroke).toBe('rule');
    expect(baseline.y1).toBe(baseline.y2);
    const bars = scene.shapes.filter((shape): shape is RectShape => shape.type === 'rect');
    expect(bars).toHaveLength(6);
    for (const bar of bars) expect(bar.y + bar.height).toBeCloseTo(baseline.y1);
  });

  it.each(CASES.filter(({ picture }) => picture.form === 'bars'))(
    'draws a bar as tall as its value, from zero: $name',
    ({ box, picture }) => {
      const scene = layoutChart(picture, {}, box);
      const unit = named<RectShape>(scene, 'p0-bar').height / 8;
      for (const point of picture.points) {
        const value = Number(point.value.replaceAll(',', ''));
        expect(named<RectShape>(scene, `${point.id}-bar`).height).toBeCloseTo(value * unit, 5);
      }
    },
  );

  it('scales the tallest bar to the top of the plot (under the mark labels), whatever the values are', () => {
    const picture = chartOf(6, 'bars', 'hidden');
    const scene = layoutChart(picture, {}, MIDDLE);
    const tallest = Math.max(...picture.points.map((point) => named<RectShape>(scene, `${point.id}-bar`).height));
    expect(tallest).toBe(named<RectShape>(scene, 'p2-bar').height);
    expect(named<RectShape>(scene, 'p2-bar').y).toBeLessThan(MIDDLE.height * 0.4);
  });

  it.each(CASES.filter(({ picture }) => picture.values === 'hidden'))(
    'prints no figure when values are hidden: $name',
    ({ box, picture }) => {
      const scene = layoutChart(picture, {}, box);
      expect(scene.shapes.filter((shape) => /-(value|unit)$/u.test(shape.key))).toEqual([]);
    },
  );

  it('prints each figure as written above its bar, with the unit after it, small', () => {
    const picture = chartOf(6, 'bars', 'shown');
    const scene = layoutChart(picture, {}, boxOf(TEST_BOXES[2] as PictureBox, 1));
    const value = named<TextShape>(scene, 'p2-value');
    const unit = named<TextShape>(scene, 'p2-unit');
    expect(value.lines).toEqual(['143']);
    expect(unit.lines).toEqual(['deaths']);
    expect(unit.size).toBeLessThan(value.size);
    expect(unit.y).toBe(value.y);
    expect(textBounds(unit).left).toBeGreaterThanOrEqual(textBounds(value).right);
    expect(value.y).toBeLessThan(named<RectShape>(scene, 'p2-bar').y);
  });

  it('thins the labels under a crowded row and keeps those of marked points', () => {
    const picture = chartOf(16, 'bars', 'hidden');
    const scene = layoutChart(picture, {}, boxOf(TEST_BOXES[0] as PictureBox, 1));
    const labels = picture.points.filter((point) => has(scene, `${point.id}-label`));
    expect(labels.length).toBeLessThan(16);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(has(scene, 'p2-label')).toBe(true);
    expect(has(scene, 'p13-label')).toBe(true);
    const wide = layoutChart(chartOf(6, 'bars', 'hidden'), {}, boxOf(TEST_BOXES[2] as PictureBox, 1));
    for (let index = 0; index < 6; index += 1) expect(has(wide, `p${index}-label`)).toBe(true);
  });

  it('joins a line’s points with one segment per pair, keyed by the pair, and a dot at each point', () => {
    const picture = chartOf(6, 'line', 'hidden');
    const scene = layoutChart(picture, {}, MIDDLE);
    const segments = scene.shapes.filter((shape) => shape.key.endsWith('-segment'));
    expect(segments.map((shape) => shape.key)).toEqual([
      'p0-p1-segment',
      'p1-p2-segment',
      'p2-p3-segment',
      'p3-p4-segment',
      'p4-p5-segment',
    ]);
    for (const point of picture.points) expect(named<CircleShape>(scene, `${point.id}-dot`).part).toBe(point.id);
    const first = named<LineShape>(scene, 'p0-p1-segment');
    expect([first.x1, first.y1]).toEqual([
      named<CircleShape>(scene, 'p0-dot').cx,
      named<CircleShape>(scene, 'p0-dot').cy,
    ]);
    expect([first.x2, first.y2]).toEqual([
      named<CircleShape>(scene, 'p1-dot').cx,
      named<CircleShape>(scene, 'p1-dot').cy,
    ]);
    expect(named<CircleShape>(scene, 'p1-dot').fill).toBe('warm');
  });

  it('runs a line chart’s scale from the least of 0 and the minimum', () => {
    const picture: ChartPicture = {
      ...chartOf(2, 'line', 'hidden'),
      points: [
        { id: 'a', label: 'Jan', value: '-10' },
        { id: 'b', label: 'Feb', value: '30' },
      ],
    };
    const scene = layoutChart(picture, {}, MIDDLE);
    const lowest = named<CircleShape>(scene, 'a-dot').cy;
    const highest = named<CircleShape>(scene, 'b-dot').cy;
    const zero = named<LineShape>(scene, 'baseline').y1;
    expect(lowest).toBeGreaterThan(zero);
    expect(zero - highest).toBeCloseTo((lowest - zero) * 3, 5);
  });

  it('draws a mark as a dashed line at its point and its label near the top, clear of other text', () => {
    const picture = chartOf(16, 'line', 'shown');
    const scene = layoutChart(picture, {}, MIDDLE);
    const line = named<LineShape>(scene, 'mark-p13-line');
    const label = named<TextShape>(scene, 'mark-p13');
    expect(line.dashed).toBe(true);
    expect(line.x1).toBe(line.x2);
    expect(line.x1).toBe(named<CircleShape>(scene, 'p13-dot').cx);
    expect(label.lines).toEqual(['Handle removed']);
    expect(label.y).toBeLessThan(MIDDLE.height * 0.2);
    expect(line.y1).toBeGreaterThan(label.y);
    expect(line.y2).toBeLessThan(named<CircleShape>(scene, 'p13-dot').cy);
  });

  it('colours a tone on its bar or dot, and lights points in mark with the rest receded', () => {
    const picture = chartOf(6, 'bars', 'shown');
    const plain = layoutChart(picture, {}, MIDDLE);
    expect(named<RectShape>(plain, 'p1-bar').fill).toBe('warm');
    expect(named<RectShape>(plain, 'p0-bar').fill).not.toBe('mark');
    const lit = layoutChart(picture, { lit: ['p3'] }, MIDDLE);
    expect(named<RectShape>(lit, 'p3-bar').fill).toBe('mark');
    expect(opacityOf(lit, 'p3-bar')).toBe(1);
    expect(opacityOf(lit, 'p3-label')).toBe(1);
    expect(opacityOf(lit, 'p1-bar')).toBe(RECEDED);
    expect(opacityOf(lit, 'p0-bar')).toBe(RECEDED);
    const line = layoutChart(chartOf(6, 'line', 'hidden'), { lit: ['p2', 'p3'] }, MIDDLE);
    expect(named<LineShape>(line, 'p2-p3-segment')).toMatchObject({ stroke: 'mark', opacity: 1 });
    expect(opacityOf(line, 'p3-p4-segment')).toBe(RECEDED);
  });

  it('hides the points past upTo at opacity 0, with their segments, labels, values and marks, and keeps their keys', () => {
    const picture = chartOf(6, 'line', 'shown');
    const scene = layoutChart(picture, { upTo: 3 }, MIDDLE);
    for (const key of ['p2-dot', 'p2-label', 'p2-value', 'p1-p2-segment', 'mark-p2', 'mark-p2-line'])
      expect(opacityOf(scene, key)).toBe(1);
    for (const key of ['p3-dot', 'p3-label', 'p3-p4-segment', 'p2-p3-segment', 'p5-dot', 'mark-p3', 'mark-p3-line'])
      if (has(scene, key)) expect(opacityOf(scene, key)).toBe(0);
    expect(opacityOf(scene, 'p2-p3-segment')).toBe(0);
    expect(opacityOf(scene, 'p5-dot')).toBe(0);
    expect(opacityOf(scene, 'mark-p3')).toBe(0);
    const whole = layoutChart(picture, {}, MIDDLE);
    expect(named<CircleShape>(scene, 'p5-dot').cx).toBe(named<CircleShape>(whole, 'p5-dot').cx);
  });

  it('draws a chart of zeros and a single large figure without failing', () => {
    const zeros: ChartPicture = {
      ...chartOf(2, 'bars', 'shown'),
      points: [
        { id: 'a', label: 'A', value: '0' },
        { id: 'b', label: 'B', value: '0' },
      ],
    };
    const scene = layoutChart(zeros, {}, MIDDLE);
    expect(shapesOutside(scene)).toEqual([]);
    expect(named<RectShape>(scene, 'a-bar').height).toBe(0);
  });
});
