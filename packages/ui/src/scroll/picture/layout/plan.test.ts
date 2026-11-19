import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, PictureShape, TextShape } from '../scene';
import { textWidth } from '../text';
import { BOLD_SLACK, MARGIN, RECEDED } from './common';
import { layoutPlan } from './plan';

type PlanPicture = PictureOfKind<'plan'>;

const cell = (column: number, row: number) => ({ column, row });
const tally = (column: number, row: number, count: number, step?: number) => ({
  at: cell(column, row),
  count,
  ...(step === undefined ? {} : { step }),
});

/** A test copy of the Soho plan the Broad Street fixture draws: the same places, ways, route and tallies. */
const SOHO: PlanPicture = {
  id: 'soho',
  kind: 'plan',
  title: 'Soho, 31 August to 9 September 1854',
  caption: "Schematic, after John Snow's 1855 map",
  size: { columns: 10, rows: 8 },
  ways: [
    { id: 'broad', label: 'Broad Street', from: cell(0, 4), to: cell(9, 4) },
    { id: 'marlborough', label: 'Marlborough Street', from: cell(0, 1), to: cell(9, 1) },
    { id: 'poland', label: 'Poland Street', from: cell(2, 0), to: cell(2, 7) },
    { id: 'cambridge', label: 'Cambridge Street', from: cell(7, 2), to: cell(7, 7) },
  ],
  places: [
    { id: 'pump-broad', label: 'Broad Street pump', at: cell(5, 4), mark: 'ring', tone: 'warm' },
    { id: 'pump-marlborough', label: 'Marlborough Street pump', at: cell(1, 1), mark: 'ring' },
    { id: 'pump-rupert', label: 'Rupert Street pump', at: cell(9, 7), mark: 'ring' },
    { id: 'pump-north', label: 'Another street pump', at: cell(5, 0), mark: 'ring' },
    { id: 'pump-south', label: 'Another street pump', at: cell(4, 7), mark: 'ring' },
    { id: 'brewery', label: 'Brewery', at: cell(6, 4), mark: 'block' },
    { id: 'workhouse', label: 'Workhouse', at: cell(2, 6), mark: 'block' },
    { id: 'hampstead', label: 'West End, Hampstead', at: cell(9, 0), mark: 'dot' },
  ],
  tallies: [
    tally(5, 5, 1, 0),
    tally(5, 5, 3, 1),
    tally(4, 4, 3, 1),
    tally(6, 5, 3, 1),
    tally(4, 3, 3, 1),
    tally(5, 3, 2, 1),
    tally(5, 5, 4, 2),
    tally(4, 4, 3, 2),
    tally(6, 5, 3, 2),
    tally(4, 3, 3, 2),
    tally(5, 3, 3, 2),
    tally(4, 5, 3, 2),
    tally(6, 3, 3, 2),
    tally(3, 4, 3, 2),
    tally(5, 5, 29, 9),
    tally(1, 2, 1, 3),
    tally(8, 6, 1, 5),
    tally(2, 6, 1, 4),
    tally(9, 0, 1, 2),
  ],
  steps: ['31 Aug', '1 Sep', '2 Sep', '3 Sep', '4 Sep', '5 Sep', '6 Sep', '7 Sep', '8 Sep', '9 Sep'],
  regions: [
    {
      id: 'near-broad',
      label: 'Nearer the Broad Street pump',
      nearest: 'pump-broad',
      among: ['pump-broad', 'pump-marlborough', 'pump-rupert', 'pump-north', 'pump-south'],
    },
  ],
  routes: [{ id: 'cart', label: 'The daily cart', from: 'pump-broad', to: 'hampstead' }],
};

const SIZES = [
  { width: 320, height: 190 },
  { width: 390, height: 287 },
  { width: 560, height: 380 },
  { width: 360, height: 140 },
];
const SCALES = [1, 2];
const STATES: readonly PictureState[] = [
  {},
  { step: 0 },
  { step: 9 },
  { step: 9, region: 'near-broad' },
  { step: 9, lit: ['brewery', 'workhouse'] },
  { step: 9, lit: ['hampstead', 'cart'] },
];

const boxOf = (size: { width: number; height: number }, textScale: number): PictureBox => ({ ...size, textScale });
const sceneOf = (state: PictureState, box: PictureBox, picture: PlanPicture = SOHO): PictureScene =>
  layoutPlan(picture, state, box);

const byKey = (scene: PictureScene, key: string): PictureShape => {
  const shape = scene.shapes.find((candidate) => candidate.key === key);
  if (shape === undefined) throw new Error(`no shape ${key}`);
  return shape;
};

const texts = (scene: PictureScene): TextShape[] =>
  scene.shapes.filter((shape): shape is TextShape => shape.type === 'text');

interface Extent {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The room a text takes by the same estimate the layout measures with (bold, and mono at 0.6 em). */
function textExtent(shape: TextShape): Extent {
  const width = Math.max(
    ...shape.lines.map((line) =>
      shape.family === 'mono' ? line.length * shape.size * 0.6 : textWidth(line, shape.size * BOLD_SLACK),
    ),
  );
  const left = shape.anchor === 'start' ? shape.x : shape.anchor === 'end' ? shape.x - width : shape.x - width / 2;
  const top = shape.y - shape.size;
  return { left, top, right: left + width, bottom: top + shape.lines.length * shape.lineHeight };
}

/** What a shape covers, strokes included. */
function extentOf(shape: PictureShape): Extent {
  switch (shape.type) {
    case 'rect':
      return {
        left: shape.x - shape.strokeWidth / 2,
        top: shape.y - shape.strokeWidth / 2,
        right: shape.x + shape.width + shape.strokeWidth / 2,
        bottom: shape.y + shape.height + shape.strokeWidth / 2,
      };
    case 'circle': {
      const reach = shape.r + shape.strokeWidth / 2;
      return { left: shape.cx - reach, top: shape.cy - reach, right: shape.cx + reach, bottom: shape.cy + reach };
    }
    case 'line': {
      const reach = shape.strokeWidth / 2;
      return {
        left: Math.min(shape.x1, shape.x2) - reach,
        top: Math.min(shape.y1, shape.y2) - reach,
        right: Math.max(shape.x1, shape.x2) + reach,
        bottom: Math.max(shape.y1, shape.y2) + reach,
      };
    }
    case 'arc':
      return {
        left: shape.cx - shape.r,
        top: shape.cy - shape.r,
        right: shape.cx + shape.r,
        bottom: shape.cy + shape.r,
      };
    case 'text':
      return textExtent(shape);
  }
}

const overlap = (a: Extent, b: Extent): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const matrix = SIZES.flatMap((size) => SCALES.map((scale) => ({ size, scale })));

describe('layoutPlan', () => {
  it.each(matrix)(
    'keeps every shape inside the $size.width x $size.height box at text scale $scale',
    ({ size, scale }) => {
      const box = boxOf(size, scale);
      for (const state of STATES)
        for (const shape of sceneOf(state, box).shapes) {
          const extent = extentOf(shape);
          // A tolerance of half a pixel for the round caps and estimated text widths at the very edge.
          expect(extent.left).toBeGreaterThanOrEqual(-0.5);
          expect(extent.top).toBeGreaterThanOrEqual(-0.5);
          expect(extent.right).toBeLessThanOrEqual(box.width + 0.5);
          expect(extent.bottom).toBeLessThanOrEqual(box.height + 0.5);
        }
    },
  );

  it.each(matrix)('never lays text over text at $size.width x $size.height, text scale $scale', ({ size, scale }) => {
    for (const state of STATES) {
      const found = texts(sceneOf(state, boxOf(size, scale)));
      found.forEach((first, index) =>
        found.slice(index + 1).forEach((second) => {
          if (overlap(textExtent(first), textExtent(second)))
            throw new Error(`${first.key} overlaps ${second.key} in ${JSON.stringify(state)}`);
        }),
      );
    }
  });

  it.each(matrix)('never drops a place label at $size.width x $size.height, text scale $scale', ({ size, scale }) => {
    const scene = sceneOf({}, boxOf(size, scale));
    for (const place of SOHO.places)
      expect(scene.shapes.some((shape) => shape.key === `place-${place.id}-label`)).toBe(true);
  });

  it('draws the same shape keys, all different, in every state', () => {
    for (const { size, scale } of matrix) {
      const box = boxOf(size, scale);
      const [first, ...rest] = STATES.map((state) => sceneOf(state, box).shapes.map((shape) => shape.key));
      expect(new Set(first).size).toBe(first?.length);
      for (const keys of rest) expect(keys).toEqual(first);
    }
  });

  it('is pure: the same picture, state and box give the same scene', () => {
    const box = boxOf(SIZES[0] ?? { width: 320, height: 190 }, 1);
    expect(sceneOf(STATES[4] ?? {}, box)).toEqual(sceneOf(STATES[4] ?? {}, box));
    expect(JSON.stringify(sceneOf(STATES[3] ?? {}, box))).toBe(JSON.stringify(sceneOf(STATES[3] ?? {}, box)));
  });

  it('fits square cells to the box, centred, with no grid lines', () => {
    const plan: PlanPicture = {
      ...SOHO,
      ways: [],
      tallies: [],
      regions: [],
      routes: [],
      steps: undefined,
      places: [
        { id: 'a', label: 'A', at: cell(0, 0), mark: 'dot' },
        { id: 'b', label: 'B', at: cell(1, 0), mark: 'dot' },
        { id: 'c', label: 'C', at: cell(0, 1), mark: 'dot' },
      ],
    };
    const scene = sceneOf({}, { width: 390, height: 287, textScale: 1 }, plan);
    const centre = (id: string) => {
      const shape = byKey(scene, `place-${id}`);
      if (shape.type !== 'circle') throw new Error('a dot is a circle');
      return shape;
    };
    const room = { width: 390 - 2 * MARGIN, height: 287 - 2 * MARGIN };
    const side = Math.min(room.width / 10, room.height / 8);
    expect(centre('b').cx - centre('a').cx).toBeCloseTo(side);
    expect(centre('c').cy - centre('a').cy).toBeCloseTo(side);
    // The 10 x 8 grid is centred in the room, and the first cell's centre is half a cell in.
    expect(centre('a').cx).toBeCloseTo(MARGIN + (room.width - 10 * side) / 2 + side / 2);
    expect(centre('a').cy).toBeCloseTo(MARGIN + (room.height - 8 * side) / 2 + side / 2);
    expect(scene.shapes.filter((shape) => shape.type === 'line')).toHaveLength(0);
  });

  describe('ways', () => {
    it('are thick strokes of about a third of a cell, drawn before places and tallies', () => {
      const scene = sceneOf({ step: 9 }, { width: 560, height: 380, textScale: 1 });
      const cellSide = Math.min((560 - 2 * MARGIN) / 10, (380 - 2 * MARGIN) / 8);
      const way = byKey(scene, 'way-broad');
      if (way.type !== 'line') throw new Error('a way is a line');
      expect(way.strokeWidth).toBeCloseTo(cellSide / 3);
      expect(way.dashed).toBe(false);
      expect(way.stroke).toBe('rule');
      expect(way.y1).toBe(way.y2);
      const order = scene.shapes.map((shape) => shape.key);
      expect(order.indexOf('way-broad')).toBeLessThan(order.indexOf('place-pump-broad'));
      expect(order.indexOf('way-broad')).toBeLessThan(order.indexOf('tally-0-0'));
    });
  });

  describe('regions', () => {
    const box = { width: 560, height: 380, textScale: 1 };
    const shaded = (state: PictureState): Set<string> =>
      new Set(
        sceneOf(state, box)
          .shapes.filter((shape) => shape.key.startsWith('region-') && shape.opacity > 0)
          .map((shape) => shape.key.replace('region-near-broad-', '')),
      );

    it('shade exactly the cells nearer to the pump than to any other pump, checked by hand', () => {
      const cells = shaded({ step: 9, region: 'near-broad' });
      // Nearer to Broad Street (5,4) than to the north pump (5,0) or the Marlborough pump (1,1) or any other.
      for (const inside of ['5-3', '5-4', '3-4', '2-4', '7-4', '6-5', '4-5']) expect(cells.has(inside)).toBe(true);
      // (5,2) is as near the north pump as Broad Street and (6,6) as near the south one: a tie belongs to neither.
      for (const outside of ['5-2', '6-6', '5-1', '1-4', '9-4', '0-0', '9-7', '4-7'])
        expect(cells.has(outside)).toBe(false);
    });

    it('agree with a count of every cell by squared distance', () => {
      const pumps = SOHO.places.filter((place) => place.id.startsWith('pump'));
      let expected = 0;
      for (let row = 0; row < 8; row += 1)
        for (let column = 0; column < 10; column += 1) {
          const distance = (at: { column: number; row: number }) => (at.column - column) ** 2 + (at.row - row) ** 2;
          const home = distance(cell(5, 4));
          if (pumps.every((pump) => pump.id === 'pump-broad' || home < distance(pump.at))) expected += 1;
        }
      expect(shaded({ region: 'near-broad' }).size).toBe(expected);
    });

    it('are tiled flush: the cell above the pump meets the pump cell', () => {
      const scene = sceneOf({ region: 'near-broad' }, box);
      const above = byKey(scene, 'region-near-broad-5-3');
      const pumpCell = byKey(scene, 'region-near-broad-5-4');
      const pump = byKey(scene, 'place-pump-broad');
      if (above.type !== 'rect' || pumpCell.type !== 'rect' || pump.type !== 'circle') throw new Error('shapes');
      expect(above.x).toBeCloseTo(pumpCell.x);
      expect(above.y + above.height).toBeCloseTo(pumpCell.y);
      expect(pumpCell.x + pumpCell.width / 2).toBeCloseTo(pump.cx);
      expect(pumpCell.y + pumpCell.height / 2).toBeCloseTo(pump.cy);
      expect(above.opacity).toBeCloseTo(0.16);
      expect(above.fill).toBe('mark');
    });

    it('are invisible unless the state names them, with the same shapes present', () => {
      for (const state of [{}, { step: 9 }, { step: 9, region: 'unknown' }]) expect(shaded(state).size).toBe(0);
      const hidden = sceneOf({ step: 9 }, box).shapes.filter((shape) => shape.key.startsWith('region-'));
      expect(hidden.length).toBeGreaterThan(0);
      expect(hidden.every((shape) => shape.opacity === 0)).toBe(true);
    });
  });

  describe('tallies', () => {
    const box = { width: 560, height: 380, textScale: 1 };
    const bars = (scene: PictureScene) => scene.shapes.filter((shape) => shape.key.startsWith('tally-'));

    it('draw each tally as count bars keyed tally-<index>-<n>', () => {
      const scene = sceneOf({}, box);
      expect(bars(scene)).toHaveLength(SOHO.tallies.reduce((total, entry) => total + entry.count, 0));
      expect(byKey(scene, 'tally-14-28').type).toBe('rect');
      expect(scene.shapes.some((shape) => shape.key === 'tally-14-29')).toBe(false);
    });

    it('wait at opacity 0 until their step, and show at or before it', () => {
      const scene = sceneOf({ step: 3 }, box);
      SOHO.tallies.forEach((entry, index) => {
        const expected = entry.step === undefined || entry.step <= 3 ? 1 : 0;
        for (let bar = 0; bar < entry.count; bar += 1)
          expect(byKey(scene, `tally-${index}-${bar}`).opacity).toBe(expected);
      });
    });

    it('all show when the state has no step, and a tally without a step is always shown', () => {
      expect(bars(sceneOf({}, box)).every((shape) => shape.opacity === 1)).toBe(true);
      const plan: PlanPicture = { ...SOHO, tallies: [tally(1, 1, 2), tally(2, 2, 2, 5)] };
      const scene = sceneOf({ step: 0 }, box, plan);
      expect(byKey(scene, 'tally-0-0').opacity).toBe(1);
      expect(byKey(scene, 'tally-1-0').opacity).toBe(0);
    });

    it('stack in their cell without overlapping, and stay put when later tallies arrive', () => {
      const scene = sceneOf({ step: 9 }, box);
      const stack = [0, 6, 14].flatMap((index) => {
        const entry = SOHO.tallies[index];
        return entry === undefined
          ? []
          : Array.from({ length: entry.count }, (_, bar) => byKey(scene, `tally-${index}-${bar}`));
      });
      stack.forEach((first, index) =>
        stack.slice(index + 1).forEach((second) => {
          expect(overlap(extentOf(first), extentOf(second))).toBe(false);
        }),
      );
      const earlier = sceneOf({ step: 1 }, box);
      expect(byKey(earlier, 'tally-1-0')).toEqual({ ...byKey(scene, 'tally-1-0') });
    });
  });

  describe('state', () => {
    const box = { width: 390, height: 287, textScale: 1 };

    it('recedes everything but the lit places, and bolds their labels', () => {
      const scene = sceneOf({ step: 9, lit: ['brewery', 'workhouse'] }, box);
      expect(byKey(scene, 'place-brewery').opacity).toBe(1);
      expect(byKey(scene, 'place-workhouse').opacity).toBe(1);
      for (const key of [
        'place-pump-broad',
        'place-hampstead',
        'way-broad',
        'route-cart',
        'tally-14-0',
        'place-hampstead-label',
      ])
        expect(byKey(scene, key).opacity).toBe(RECEDED);
      const lit = byKey(scene, 'place-brewery');
      if (lit.type !== 'rect') throw new Error('a block is a rect');
      expect(lit.stroke).toBe('mark');
      const label = byKey(scene, 'place-brewery-label');
      if (label.type !== 'text') throw new Error('a label is text');
      expect(label.weight).toBe('bold');
      expect(byKey(scene, 'place-pump-broad-label')).toMatchObject({ weight: 'regular', opacity: RECEDED });
    });

    it('draws a lit route in mark, and a route otherwise dashed in ink2', () => {
      const lit = byKey(sceneOf({ lit: ['hampstead', 'cart'] }, box), 'route-cart');
      const plain = byKey(sceneOf({}, box), 'route-cart');
      expect(lit).toMatchObject({ type: 'line', stroke: 'mark', dashed: true, opacity: 1 });
      expect(plain).toMatchObject({ type: 'line', stroke: 'ink2', dashed: true, opacity: 1 });
    });

    it('draws nothing receded when nothing is lit', () => {
      const scene = sceneOf({ step: 9 }, box);
      expect(scene.shapes.filter((shape) => shape.opacity === RECEDED)).toHaveLength(0);
    });

    it('draws a dot, a block and a ring as their marks, a pump in the plate fill', () => {
      const scene = sceneOf({}, { width: 560, height: 380, textScale: 1 });
      expect(byKey(scene, 'place-hampstead').type).toBe('circle');
      expect(byKey(scene, 'place-brewery')).toMatchObject({ type: 'rect', fill: 'raised' });
      expect(byKey(scene, 'place-pump-broad')).toMatchObject({ type: 'circle', fill: 'raised', stroke: 'warm' });
      expect(byKey(scene, 'place-pump-rupert')).toMatchObject({ type: 'circle', fill: 'raised', stroke: 'ink' });
    });
  });

  describe('step', () => {
    it("names the state's step in mono, top-left, or the last step without one", () => {
      const box = { width: 390, height: 287, textScale: 1 };
      for (const [state, text] of [
        [{ step: 3 }, '3 Sep'],
        [{}, '9 Sep'],
      ] as const) {
        const step = byKey(sceneOf(state, box), 'step');
        if (step.type !== 'text') throw new Error('the step is text');
        expect(step.lines).toEqual([text]);
        expect(step.family).toBe('mono');
        expect(step.x).toBe(MARGIN);
        expect(step.y).toBeLessThan(MARGIN + step.size * 1.5);
      }
    });

    it('is absent from a plan without steps', () => {
      const plan: PlanPicture = { ...SOHO, steps: undefined, tallies: [tally(1, 1, 2)] };
      expect(
        sceneOf({}, { width: 390, height: 287, textScale: 1 }, plan).shapes.some((shape) => shape.key === 'step'),
      ).toBe(false);
    });
  });

  describe('labels', () => {
    it('shrink or drop the way labels and route labels before any place label as text grows', () => {
      const small = { width: 360, height: 140, textScale: 2 };
      const scene = sceneOf({ step: 9 }, small);
      const keys = new Set(scene.shapes.map((shape) => shape.key));
      for (const place of SOHO.places) expect(keys.has(`place-${place.id}-label`)).toBe(true);
      const roomy = new Set(
        sceneOf({ step: 9 }, { width: 560, height: 380, textScale: 1 }).shapes.map((shape) => shape.key),
      );
      for (const way of SOHO.ways) expect(roomy.has(`way-${way.id}-label`)).toBe(true);
      expect(roomy.has('route-cart-label')).toBe(true);
    });

    it('stand within a cell and a half of their marker where there is room', () => {
      const scene = sceneOf({}, { width: 560, height: 380, textScale: 1 });
      const cellSide = Math.min((560 - 2 * MARGIN) / 10, (380 - 2 * MARGIN) / 8);
      for (const id of ['brewery', 'workhouse', 'hampstead', 'pump-rupert']) {
        const marker = extentOf(byKey(scene, `place-${id}`));
        const label = textExtent(byKey(scene, `place-${id}-label`) as TextShape);
        const gapX = Math.max(0, marker.left - label.right, label.left - marker.right);
        const gapY = Math.max(0, marker.top - label.bottom, label.top - marker.bottom);
        expect(Math.hypot(gapX, gapY)).toBeLessThan(cellSide * 1.5);
      }
    });

    it('never cover a place with a label', () => {
      for (const { size, scale } of matrix) {
        const scene = sceneOf({ step: 9 }, boxOf(size, scale));
        const places = scene.shapes.filter((shape) => shape.key.startsWith('place-') && shape.type !== 'text');
        for (const label of texts(scene).filter((shape) => shape.key.startsWith('place-')))
          for (const place of places) expect(overlap(textExtent(label), extentOf(place))).toBe(false);
      }
    });
  });
});
