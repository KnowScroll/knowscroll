import { describe, expect, it } from 'vitest';
import { Control, Show } from './document.js';
import {
  controlIssues,
  figureValue,
  lightItem,
  orderedItems,
  partIds,
  pickItems,
  pictureDataIssues,
  pictureStateIssues,
  revealCount,
  scrubPositions,
} from './picture-rules.js';
import { Picture, PictureState } from './pictures.js';

const state = (raw: object = {}): PictureState => PictureState.parse(raw);
const show = (raw: object = {}): Show => Show.parse({ picture: 'figure', state: raw });
const control = (raw: object): Control => Control.parse({ label: 'Move', ...raw });

const item = (id: string, label: string, extra: object = {}): object => ({ id, label, ...extra });
const cell = (column: number, row: number): object => ({ column, row });

const statementNumber = Picture.parse({
  id: 'figure',
  kind: 'statement',
  title: 'Earth tilts',
  statement: { form: 'number', value: '23.4°', label: 'Earth’s lean' },
});
const statementQuote = Picture.parse({
  id: 'figure',
  kind: 'statement',
  title: 'A line',
  statement: { form: 'quote', text: 'Nothing is lost.', who: 'Lavoisier' },
});
const statementList = Picture.parse({
  id: 'figure',
  kind: 'statement',
  title: 'Kinds',
  statement: { form: 'list', items: [item('one', 'One', { note: 'First.' }), item('two', 'Two')] },
});

const flow = (
  steps: object[] = [item('aa', 'A', { note: 'Note A.' }), item('bb', 'B', { note: 'Note B.' }), item('cc', 'C')],
): Picture => Picture.parse({ id: 'figure', kind: 'flow', title: 'Flow', steps });

const cycle = Picture.parse({
  id: 'figure',
  kind: 'cycle',
  title: 'Cycle',
  centre: item('hub', 'Hub'),
  items: [item('xx', 'X'), item('yy', 'Y'), item('zz', 'Z')],
});

const gridOf = (cells: object[]): Picture =>
  Picture.parse({
    id: 'figure',
    kind: 'grid',
    title: 'Grid',
    columns: [item('fast', 'Fast'), item('slow', 'Slow')],
    rows: [item('cheap', 'Cheap'), item('dear', 'Dear')],
    cells,
  });
const gridCell = (id: string, row: string, column: string, extra: object = {}): object => ({
  id,
  row,
  column,
  text: id,
  ...extra,
});

const chartOf = (overrides: object = {}): Picture =>
  Picture.parse({
    id: 'figure',
    kind: 'chart',
    title: 'Chart',
    form: 'bars',
    values: 'shown',
    points: [
      { id: 'p1', label: 'One', value: '3', note: 'Note one.' },
      { id: 'p2', label: 'Two', value: '1,500' },
      { id: 'p3', label: 'Three', value: '4.5' },
    ],
    marks: [{ point: 'p2', label: 'Peak' }],
    ...overrides,
  });

const planOf = (overrides: object = {}): Picture =>
  Picture.parse({
    id: 'figure',
    kind: 'plan',
    title: 'Plan',
    size: { columns: 8, rows: 8 },
    ways: [{ id: 'street', from: cell(0, 3), to: cell(7, 3) }],
    places: [
      { id: 'pump-a', label: 'Pump A', at: cell(1, 1), mark: 'dot', note: 'A note.' },
      { id: 'pump-b', label: 'Pump B', at: cell(6, 6), mark: 'ring' },
      { id: 'pump-c', label: 'Pump C', at: cell(3, 5), mark: 'block' },
    ],
    tallies: [{ at: cell(2, 2), count: 4, step: 1 }],
    steps: ['Mon', 'Tue', 'Wed'],
    regions: [{ id: 'near-a', label: 'Near A', nearest: 'pump-a', among: ['pump-a', 'pump-b'] }],
    routes: [{ id: 'walk', from: 'pump-a', to: 'pump-b' }],
    ...overrides,
  });

const codes = (issues: readonly { code: string }[]): string[] => issues.map((issue) => issue.code);

describe('orderedItems', () => {
  it('has the items of each kind in its own order', () => {
    expect(orderedItems(statementList).map((entry) => entry.id)).toEqual(['one', 'two']);
    expect(orderedItems(statementNumber)).toEqual([]);
    expect(orderedItems(statementQuote)).toEqual([]);
    expect(orderedItems(flow()).map((entry) => entry.id)).toEqual(['aa', 'bb', 'cc']);
    expect(orderedItems(cycle).map((entry) => entry.id)).toEqual(['xx', 'yy', 'zz']);
    expect(orderedItems(chartOf()).map((entry) => entry.id)).toEqual(['p1', 'p2', 'p3']);
    expect(orderedItems(planOf()).map((entry) => entry.id)).toEqual(['pump-a', 'pump-b', 'pump-c']);
  });

  it('orders grid cells by row and then by column, whatever order they are written in', () => {
    const scrambled = gridOf([
      gridCell('dear-slow', 'dear', 'slow'),
      gridCell('cheap-slow', 'cheap', 'slow'),
      gridCell('dear-fast', 'dear', 'fast'),
      gridCell('cheap-fast', 'cheap', 'fast', { note: 'Quick.', tone: 'warm' }),
    ]);
    const ordered = orderedItems(scrambled);
    expect(ordered.map((entry) => entry.id)).toEqual(['cheap-fast', 'cheap-slow', 'dear-fast', 'dear-slow']);
    expect(ordered.map((entry) => entry.label)).toEqual(['Cheap, Fast', 'Cheap, Slow', 'Dear, Fast', 'Dear, Slow']);
    expect(ordered[0]).toMatchObject({ note: 'Quick.', tone: 'warm' });
  });

  it('keeps a cell that names an unknown row or column, labelled by the id it names', () => {
    const odd = gridOf([gridCell('lost', 'ghost', 'fast'), gridCell('found', 'cheap', 'fast')]);
    expect(orderedItems(odd).map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['Cheap, Fast', 'ghost, Fast']),
    );
  });
});

describe('revealCount', () => {
  it('counts what upTo counts for each kind', () => {
    expect(revealCount(flow())).toBe(3);
    expect(revealCount(cycle)).toBe(3);
    expect(revealCount(gridOf([gridCell('only', 'cheap', 'fast')]))).toBe(2);
    expect(revealCount(chartOf())).toBe(3);
  });

  it('is zero for a statement and a plan, which upTo does not apply to', () => {
    expect(revealCount(statementList)).toBe(0);
    expect(revealCount(planOf())).toBe(0);
  });
});

describe('partIds', () => {
  it('names every part a phrase may link, in the picture’s own order', () => {
    expect(partIds(statementNumber)).toEqual(['value']);
    expect(partIds(statementQuote)).toEqual(['quote']);
    expect(partIds(statementList)).toEqual(['one', 'two']);
    expect(partIds(flow())).toEqual(['aa', 'bb', 'cc']);
    expect(partIds(cycle)).toEqual(['hub', 'xx', 'yy', 'zz']);
    expect(partIds(gridOf([gridCell('c1', 'cheap', 'fast')]))).toEqual(['cheap', 'dear', 'fast', 'slow', 'c1']);
    expect(partIds(chartOf())).toEqual(['p1', 'p2', 'p3']);
    expect(partIds(planOf())).toEqual(['street', 'pump-a', 'pump-b', 'pump-c', 'near-a', 'walk']);
  });

  it('leaves out a ring’s centre when it has none', () => {
    const { centre: _centre, ...ring } = cycle as Extract<Picture, { kind: 'cycle' }>;
    expect(partIds(Picture.parse(ring))).toEqual(['xx', 'yy', 'zz']);
  });
});

describe('figureValue', () => {
  it('reads a figure as a passage writes it', () => {
    expect(figureValue('147')).toBe(147);
    expect(figureValue('93.6')).toBe(93.6);
    expect(figureValue('1,000')).toBe(1000);
    expect(figureValue('1,234,567.5')).toBe(1234567.5);
    expect(figureValue('-12')).toBe(-12);
  });
});

describe('pictureDataIssues', () => {
  const at = 'pictures.0';

  it('accepts every well-formed picture', () => {
    const pictures = [
      statementNumber,
      statementQuote,
      statementList,
      flow(),
      cycle,
      gridOf([gridCell('c1', 'cheap', 'fast')]),
      chartOf({ form: 'line' }),
      planOf(),
    ];
    for (const picture of pictures) expect(pictureDataIssues(picture, at)).toEqual([]);
  });

  describe('picture_ids_duplicate', () => {
    it('passes unique ids and fails a repeated one in a flow, a list, a ring, a grid, a chart and a plan', () => {
      expect(pictureDataIssues(flow(), at)).toEqual([]);
      const repeated: Picture[] = [
        flow([item('aa', 'A'), item('aa', 'Again')]),
        Picture.parse({
          id: 'figure',
          kind: 'statement',
          title: 'S',
          statement: { form: 'list', items: [item('dup', 'A'), item('dup', 'B')] },
        }),
        Picture.parse({ ...cycle, centre: item('xx', 'Centre') }),
        gridOf([gridCell('cheap', 'cheap', 'fast')]),
        chartOf({
          points: [
            { id: 'p1', label: 'A', value: '1' },
            { id: 'p1', label: 'B', value: '2' },
          ],
        }),
        planOf({ regions: [{ id: 'pump-a', label: 'R', nearest: 'pump-a', among: ['pump-a', 'pump-b'] }] }),
      ];
      for (const picture of repeated)
        expect(pictureDataIssues(picture, at)).toContainEqual({ code: 'picture_ids_duplicate', path: at });
    });
  });

  describe('picture_ref_unknown', () => {
    it('passes a grid cell of a known row and column and fails an unknown row or column', () => {
      expect(pictureDataIssues(gridOf([gridCell('c1', 'cheap', 'fast')]), at)).toEqual([]);
      expect(pictureDataIssues(gridOf([gridCell('c1', 'ghost', 'fast')]), at)).toEqual([
        { code: 'picture_ref_unknown', path: 'pictures.0.cells.0' },
      ]);
      expect(codes(pictureDataIssues(gridOf([gridCell('c1', 'cheap', 'ghost')]), at))).toEqual(['picture_ref_unknown']);
    });

    it('passes a chart mark on a known point and fails one on an unknown point', () => {
      expect(pictureDataIssues(chartOf(), at)).toEqual([]);
      expect(pictureDataIssues(chartOf({ marks: [{ point: 'ghost', label: 'Peak' }] }), at)).toEqual([
        { code: 'picture_ref_unknown', path: 'pictures.0.marks.0.point' },
      ]);
    });

    it('passes a route between two places and fails an unknown end or a route to itself', () => {
      expect(pictureDataIssues(planOf(), at)).toEqual([]);
      for (const route of [
        { id: 'walk', from: 'pump-a', to: 'ghost' },
        { id: 'walk', from: 'ghost', to: 'pump-b' },
        { id: 'walk', from: 'pump-a', to: 'pump-a' },
      ])
        expect(pictureDataIssues(planOf({ routes: [route] }), at)).toEqual([
          { code: 'picture_ref_unknown', path: 'pictures.0.routes.0' },
        ]);
    });
  });

  describe('picture_cell_taken', () => {
    it('passes grid cells in different spots and fails two cells of one row and column', () => {
      expect(pictureDataIssues(gridOf([gridCell('c1', 'cheap', 'fast'), gridCell('c2', 'cheap', 'slow')]), at)).toEqual(
        [],
      );
      expect(pictureDataIssues(gridOf([gridCell('c1', 'cheap', 'fast'), gridCell('c2', 'cheap', 'fast')]), at)).toEqual(
        [{ code: 'picture_cell_taken', path: 'pictures.0.cells.1' }],
      );
    });

    it('passes places on different cells and fails two places on one cell', () => {
      expect(pictureDataIssues(planOf(), at)).toEqual([]);
      const crowded = planOf({
        places: [
          { id: 'pump-a', label: 'A', at: cell(1, 1), mark: 'dot' },
          { id: 'pump-b', label: 'B', at: cell(1, 1), mark: 'dot' },
        ],
        regions: [],
        routes: [],
      });
      expect(pictureDataIssues(crowded, at)).toEqual([{ code: 'picture_cell_taken', path: 'pictures.0.places.1.at' }]);
    });
  });

  describe('picture_cell_outside', () => {
    it('passes cells on the plan and fails a way, a place and a tally beyond it', () => {
      expect(pictureDataIssues(planOf(), at)).toEqual([]);
      expect(pictureDataIssues(planOf({ ways: [{ id: 'street', from: cell(0, 3), to: cell(8, 3) }] }), at)).toEqual([
        { code: 'picture_cell_outside', path: 'pictures.0.ways.0' },
      ]);
      expect(
        pictureDataIssues(
          planOf({ places: [{ id: 'pump-a', label: 'A', at: cell(1, 8), mark: 'dot' }], regions: [], routes: [] }),
          at,
        ),
      ).toEqual([{ code: 'picture_cell_outside', path: 'pictures.0.places.0.at' }]);
      expect(pictureDataIssues(planOf({ tallies: [{ at: cell(9, 0), count: 1 }] }), at)).toEqual([
        { code: 'picture_cell_outside', path: 'pictures.0.tallies.0.at' },
      ]);
    });

    it('counts the last column and row as on the plan', () => {
      expect(pictureDataIssues(planOf({ tallies: [{ at: cell(7, 7), count: 1 }] }), at)).toEqual([]);
    });
  });

  describe('picture_way_bent', () => {
    it('passes a straight way along a row or a column and fails a diagonal or a way of no length', () => {
      expect(pictureDataIssues(planOf({ ways: [{ id: 'street', from: cell(2, 0), to: cell(2, 7) }] }), at)).toEqual([]);
      expect(pictureDataIssues(planOf({ ways: [{ id: 'street', from: cell(0, 0), to: cell(5, 5) }] }), at)).toEqual([
        { code: 'picture_way_bent', path: 'pictures.0.ways.0' },
      ]);
      expect(pictureDataIssues(planOf({ ways: [{ id: 'street', from: cell(3, 3), to: cell(3, 3) }] }), at)).toEqual([
        { code: 'picture_way_bent', path: 'pictures.0.ways.0' },
      ]);
    });
  });

  describe('picture_steps_missing', () => {
    it('passes a stepped tally on a plan with steps and fails one on a plan without', () => {
      expect(pictureDataIssues(planOf(), at)).toEqual([]);
      expect(pictureDataIssues(planOf({ steps: undefined }), at)).toEqual([
        { code: 'picture_steps_missing', path: 'pictures.0.steps' },
      ]);
    });

    it('passes tallies with no step on a plan without steps', () => {
      expect(pictureDataIssues(planOf({ steps: undefined, tallies: [{ at: cell(2, 2), count: 4 }] }), at)).toEqual([]);
    });
  });

  describe('picture_tally_step_invalid', () => {
    it('passes a step within the steps and fails one past the last', () => {
      expect(pictureDataIssues(planOf({ tallies: [{ at: cell(2, 2), count: 1, step: 2 }] }), at)).toEqual([]);
      expect(pictureDataIssues(planOf({ tallies: [{ at: cell(2, 2), count: 1, step: 3 }] }), at)).toEqual([
        { code: 'picture_tally_step_invalid', path: 'pictures.0.tallies.0' },
      ]);
    });
  });

  describe('picture_region_invalid', () => {
    const region = (overrides: object): object => ({
      id: 'near-a',
      label: 'Near A',
      nearest: 'pump-a',
      among: ['pump-a', 'pump-b'],
      ...overrides,
    });

    it('passes a region whose nearest place is among known places', () => {
      expect(pictureDataIssues(planOf({ regions: [region({})] }), at)).toEqual([]);
    });

    it('fails a nearest place that is not among them, a repeated place and an unknown place', () => {
      for (const bad of [
        region({ nearest: 'pump-c' }),
        region({ among: ['pump-a', 'pump-b', 'pump-b'] }),
        region({ among: ['pump-a', 'ghost'] }),
      ])
        expect(pictureDataIssues(planOf({ regions: [bad] }), at)).toEqual([
          { code: 'picture_region_invalid', path: 'pictures.0.regions.0' },
        ]);
    });
  });

  describe('picture_value_invalid', () => {
    it('passes a negative value on a line and fails one on bars', () => {
      const below = [
        { id: 'p1', label: 'One', value: '3' },
        { id: 'p2', label: 'Two', value: '-4.5' },
      ];
      expect(pictureDataIssues(chartOf({ form: 'line', points: below }), at)).toEqual([]);
      expect(pictureDataIssues(chartOf({ form: 'bars', points: below }), at)).toEqual([
        { code: 'picture_value_invalid', path: 'pictures.0.points.1.value' },
      ]);
    });

    it('passes bars of zero and positive figures, with thousands commas', () => {
      const bars = chartOf({
        points: [
          { id: 'p1', label: 'One', value: '0' },
          { id: 'p2', label: 'Two', value: '1,500' },
        ],
      });
      expect(pictureDataIssues(bars, at)).toEqual([]);
    });
  });
});

describe('pictureStateIssues', () => {
  const at = 'sections.0.beats.0.show.state';
  const invalid = [{ code: 'show_state_invalid', path: at }];

  it('accepts an empty state on every kind', () => {
    for (const picture of [
      statementNumber,
      flow(),
      cycle,
      gridOf([gridCell('c1', 'cheap', 'fast')]),
      chartOf(),
      planOf(),
    ])
      expect(pictureStateIssues(picture, state(), at)).toEqual([]);
  });

  describe('a key the kind does not understand', () => {
    it('passes the keys each kind allows', () => {
      expect(pictureStateIssues(statementList, state({ lit: ['one'] }), at)).toEqual([]);
      expect(pictureStateIssues(flow(), state({ upTo: 2, lit: ['aa'] }), at)).toEqual([]);
      expect(pictureStateIssues(planOf(), state({ step: 1, lit: ['pump-a'], region: 'near-a' }), at)).toEqual([]);
    });

    it('fails upTo on a statement and a plan, and step or region on the rest', () => {
      expect(pictureStateIssues(statementList, state({ upTo: 1 }), at)).toEqual(invalid);
      expect(pictureStateIssues(planOf(), state({ upTo: 1 }), at)).toEqual(invalid);
      expect(pictureStateIssues(flow(), state({ step: 0 }), at)).toEqual(invalid);
      expect(pictureStateIssues(chartOf(), state({ region: 'near-a' }), at)).toEqual(invalid);
    });
  });

  describe('upTo', () => {
    it('passes a count within the items and fails one beyond them', () => {
      expect(pictureStateIssues(flow(), state({ upTo: 3 }), at)).toEqual([]);
      expect(pictureStateIssues(flow(), state({ upTo: 4 }), at)).toEqual(invalid);
      expect(pictureStateIssues(gridOf([gridCell('c1', 'cheap', 'fast')]), state({ upTo: 2 }), at)).toEqual([]);
      expect(pictureStateIssues(gridOf([gridCell('c1', 'cheap', 'fast')]), state({ upTo: 3 }), at)).toEqual(invalid);
    });
  });

  describe('lit', () => {
    it('passes ids that are parts and fails an unknown id', () => {
      expect(pictureStateIssues(cycle, state({ lit: ['hub', 'xx'] }), at)).toEqual([]);
      expect(pictureStateIssues(cycle, state({ lit: ['ghost'] }), at)).toEqual(invalid);
    });

    it('passes the parts of a grid and a statement number, and fails a repeated id', () => {
      expect(
        pictureStateIssues(gridOf([gridCell('c1', 'cheap', 'fast')]), state({ lit: ['dear', 'slow', 'c1'] }), at),
      ).toEqual([]);
      expect(pictureStateIssues(statementNumber, state({ lit: ['value'] }), at)).toEqual([]);
      expect(pictureStateIssues(flow(), state({ lit: ['aa', 'aa'] }), at)).toEqual(invalid);
    });
  });

  describe('step', () => {
    it('passes a step within the plan’s steps and fails one past them', () => {
      expect(pictureStateIssues(planOf(), state({ step: 2 }), at)).toEqual([]);
      expect(pictureStateIssues(planOf(), state({ step: 3 }), at)).toEqual(invalid);
    });

    it('fails a step on a plan that has no steps', () => {
      expect(pictureStateIssues(planOf({ steps: undefined, tallies: [] }), state({ step: 0 }), at)).toEqual(invalid);
    });
  });

  describe('region', () => {
    it('passes a region the plan declares and fails one it does not', () => {
      expect(pictureStateIssues(planOf(), state({ region: 'near-a' }), at)).toEqual([]);
      expect(pictureStateIssues(planOf(), state({ region: 'ghost' }), at)).toEqual(invalid);
    });
  });
});

describe('scrubPositions', () => {
  describe('along steps', () => {
    it('walks a plan’s steps by name, keeping the rest of the base state', () => {
      const positions = scrubPositions(planOf(), state({ lit: ['pump-a'], region: 'near-a' }), 'steps');
      expect(positions.map((position) => position.label)).toEqual(['Mon', 'Tue', 'Wed']);
      expect(positions.map((position) => position.state)).toEqual([
        { lit: ['pump-a'], region: 'near-a', step: 0 },
        { lit: ['pump-a'], region: 'near-a', step: 1 },
        { lit: ['pump-a'], region: 'near-a', step: 2 },
      ]);
    });

    it('has nowhere to go on a plan without steps', () => {
      expect(scrubPositions(planOf({ steps: undefined, tallies: [] }), state(), 'steps')).toEqual([]);
    });

    it('reveals a flow, a ring and a chart one more item at a time, labelled by the item just revealed', () => {
      expect(scrubPositions(flow(), state(), 'steps')).toEqual([
        { label: 'A', state: { upTo: 1 } },
        { label: 'B', state: { upTo: 2 } },
        { label: 'C', state: { upTo: 3 } },
      ]);
      expect(scrubPositions(cycle, state({ lit: ['hub'] }), 'steps')).toEqual([
        { label: 'X', state: { lit: ['hub'], upTo: 1 } },
        { label: 'Y', state: { lit: ['hub'], upTo: 2 } },
        { label: 'Z', state: { lit: ['hub'], upTo: 3 } },
      ]);
      expect(scrubPositions(chartOf(), state(), 'steps').map((position) => position.label)).toEqual([
        'One',
        'Two',
        'Three',
      ]);
    });

    it('reveals a grid a row at a time, labelled by the row, not by a cell', () => {
      const positions = scrubPositions(gridOf([gridCell('c1', 'cheap', 'fast')]), state(), 'steps');
      expect(positions).toEqual([
        { label: 'Cheap', state: { upTo: 1 } },
        { label: 'Dear', state: { upTo: 2 } },
      ]);
    });

    it('has nowhere to go on a statement', () => {
      expect(scrubPositions(statementList, state(), 'steps')).toEqual([]);
      expect(scrubPositions(statementNumber, state(), 'steps')).toEqual([]);
    });
  });

  describe('along items', () => {
    it('lights each item of a flow, a ring (not its centre), a chart and a statement list in turn', () => {
      expect(scrubPositions(flow(), state(), 'items').map((position) => position.state)).toEqual([
        { lit: ['aa'] },
        { lit: ['bb'] },
        { lit: ['cc'] },
      ]);
      expect(scrubPositions(cycle, state(), 'items').map((position) => position.label)).toEqual(['X', 'Y', 'Z']);
      expect(scrubPositions(chartOf(), state(), 'items').map((position) => position.label)).toEqual([
        'One',
        'Two',
        'Three',
      ]);
      expect(scrubPositions(statementList, state(), 'items').map((position) => position.label)).toEqual(['One', 'Two']);
    });

    it('lights the cells of a grid by row and column, and the places of a plan', () => {
      const cells = [gridCell('c2', 'dear', 'slow'), gridCell('c1', 'cheap', 'fast')];
      expect(scrubPositions(gridOf(cells), state(), 'items')).toEqual([
        { label: 'Cheap, Fast', state: { lit: ['c1'] } },
        { label: 'Dear, Slow', state: { lit: ['c2'] } },
      ]);
      expect(scrubPositions(planOf(), state({ step: 1 }), 'items')).toEqual([
        { label: 'Pump A', state: { step: 1, lit: ['pump-a'] } },
        { label: 'Pump B', state: { step: 1, lit: ['pump-b'] } },
        { label: 'Pump C', state: { step: 1, lit: ['pump-c'] } },
      ]);
    });

    it('reveals each item the beat’s upTo has not reached, and keeps upTo for the ones it has', () => {
      expect(scrubPositions(flow(), state({ upTo: 1 }), 'items').map((position) => position.state)).toEqual([
        { upTo: 1, lit: ['aa'] },
        { upTo: 2, lit: ['bb'] },
        { upTo: 3, lit: ['cc'] },
      ]);
      expect(scrubPositions(chartOf(), state({ upTo: 2 }), 'items').map((position) => position.state)).toEqual([
        { upTo: 2, lit: ['p1'] },
        { upTo: 2, lit: ['p2'] },
        { upTo: 3, lit: ['p3'] },
      ]);
      expect(scrubPositions(cycle, state({ upTo: 1 }), 'items').map((position) => position.state.upTo)).toEqual([
        1, 2, 3,
      ]);
    });

    it('leaves a state with no upTo as it was: everything is revealed already', () => {
      expect(scrubPositions(flow(), state({ lit: ['cc'] }), 'items').map((position) => position.state)).toEqual([
        { lit: ['aa'] },
        { lit: ['bb'] },
        { lit: ['cc'] },
      ]);
    });

    it('reveals a grid cell by its row, since upTo counts rows', () => {
      const cells = [gridCell('c2', 'dear', 'slow'), gridCell('c1', 'cheap', 'fast')];
      expect(scrubPositions(gridOf(cells), state({ upTo: 1 }), 'items').map((position) => position.state)).toEqual([
        { upTo: 1, lit: ['c1'] },
        { upTo: 2, lit: ['c2'] },
      ]);
    });

    it('replaces a base lit state, and has nowhere to go on a statement number or quotation', () => {
      expect(scrubPositions(flow(), state({ lit: ['cc'] }), 'items')[0]?.state).toEqual({ lit: ['aa'] });
      expect(scrubPositions(statementNumber, state(), 'items')).toEqual([]);
      expect(scrubPositions(statementQuote, state(), 'items')).toEqual([]);
    });
  });
});

describe('lightItem', () => {
  it('lights the item and raises upTo to its place when upTo has not reached it', () => {
    expect(lightItem(flow(), state({ upTo: 1 }), 'cc')).toEqual({ upTo: 3, lit: ['cc'] });
    expect(lightItem(chartOf(), state({ upTo: 1 }), 'p2')).toEqual({ upTo: 2, lit: ['p2'] });
    expect(lightItem(cycle, state({ upTo: 2 }), 'zz')).toEqual({ upTo: 3, lit: ['zz'] });
  });

  it('keeps an upTo that already reveals the item, and a state with no upTo', () => {
    expect(lightItem(flow(), state({ upTo: 3 }), 'bb')).toEqual({ upTo: 3, lit: ['bb'] });
    expect(lightItem(flow(), state({ upTo: 1 }), 'aa')).toEqual({ upTo: 1, lit: ['aa'] });
    expect(lightItem(flow(), state(), 'cc')).toEqual({ lit: ['cc'] });
  });

  it('keeps the other keys of the state and replaces a lit one', () => {
    expect(lightItem(planOf(), state({ step: 1, lit: ['pump-a'] }), 'pump-c')).toEqual({ step: 1, lit: ['pump-c'] });
  });

  it('changes nothing about upTo where it counts nothing (a statement list, a plan) or the id is no item', () => {
    expect(lightItem(statementList, state(), 'two')).toEqual({ lit: ['two'] });
    expect(lightItem(flow(), state({ upTo: 1 }), 'nowhere')).toEqual({ upTo: 1, lit: ['nowhere'] });
  });

  it('reveals a grid cell by its row', () => {
    const grid = gridOf([gridCell('c2', 'dear', 'slow'), gridCell('c1', 'cheap', 'fast')]);
    expect(lightItem(grid, state({ upTo: 1 }), 'c2')).toEqual({ upTo: 2, lit: ['c2'] });
    expect(lightItem(grid, state({ upTo: 1 }), 'c1')).toEqual({ upTo: 1, lit: ['c1'] });
  });

  it('gives a state the picture can be in, so a scrub or a pick never leaves the picture’s own rules', () => {
    const picture = flow();
    for (const id of ['aa', 'bb', 'cc'])
      expect(pictureStateIssues(picture, lightItem(picture, state({ upTo: 1 }), id), 'p')).toEqual([]);
  });
});

describe('pickItems', () => {
  it('offers only the items that have a note', () => {
    expect(pickItems(flow()).map((entry) => entry.id)).toEqual(['aa', 'bb']);
    expect(pickItems(statementList).map((entry) => entry.id)).toEqual(['one']);
    expect(pickItems(chartOf()).map((entry) => entry.id)).toEqual(['p1']);
    expect(pickItems(planOf()).map((entry) => entry.id)).toEqual(['pump-a']);
  });

  it('offers a grid’s cells with notes, labelled by row and column', () => {
    const noted = gridOf([gridCell('c1', 'cheap', 'fast', { note: 'Quick.' }), gridCell('c2', 'cheap', 'slow')]);
    expect(pickItems(noted)).toMatchObject([{ id: 'c1', label: 'Cheap, Fast' }]);
  });

  it('offers nothing on a statement number and nothing when no item has a note', () => {
    expect(pickItems(statementNumber)).toEqual([]);
    expect(pickItems(cycle)).toEqual([]);
  });
});

describe('controlIssues: control_unfit', () => {
  const at = 'sections.0.beats.0.control';
  const unfit = [{ code: 'control_unfit', path: at }];

  describe('scrub', () => {
    it('passes where there are two places to go and fails where there are fewer', () => {
      expect(controlIssues(flow(), control({ kind: 'scrub', along: 'items' }), show(), at)).toEqual([]);
      expect(controlIssues(planOf(), control({ kind: 'scrub', along: 'steps' }), show(), at)).toEqual([]);
      expect(controlIssues(statementNumber, control({ kind: 'scrub', along: 'items' }), show(), at)).toEqual(unfit);
      expect(
        controlIssues(
          planOf({ steps: undefined, tallies: [] }),
          control({ kind: 'scrub', along: 'steps' }),
          show(),
          at,
        ),
      ).toEqual(unfit);
    });

    it('fails a grid of one row scrubbed by steps', () => {
      const oneRow = Picture.parse({
        id: 'figure',
        kind: 'grid',
        title: 'Grid',
        columns: [item('fast', 'Fast')],
        rows: [item('cheap', 'Cheap')],
        cells: [gridCell('c1', 'cheap', 'fast')],
      });
      expect(controlIssues(oneRow, control({ kind: 'scrub', along: 'steps' }), show(), at)).toEqual(unfit);
    });
  });

  describe('switch', () => {
    it('passes a valid state that differs from the beat’s own', () => {
      expect(controlIssues(flow(), control({ kind: 'switch', to: { upTo: 2 } }), show({ upTo: 3 }), at)).toEqual([]);
    });

    it('fails a state the picture cannot be in', () => {
      expect(controlIssues(flow(), control({ kind: 'switch', to: { upTo: 9 } }), show(), at)).toEqual(unfit);
      expect(controlIssues(flow(), control({ kind: 'switch', to: { step: 1 } }), show(), at)).toEqual(unfit);
    });

    it('fails a state equal to the beat’s own, whatever order its keys are written in', () => {
      expect(
        controlIssues(
          flow(),
          control({ kind: 'switch', to: { upTo: 2, lit: ['aa'] } }),
          show({ lit: ['aa'], upTo: 2 }),
          at,
        ),
      ).toEqual(unfit);
    });
  });

  describe('pick', () => {
    it('passes a picture with two items that have notes', () => {
      expect(controlIssues(flow(), control({ kind: 'pick' }), show(), at)).toEqual([]);
    });

    it('fails a picture with one noted item or none', () => {
      expect(controlIssues(statementList, control({ kind: 'pick' }), show(), at)).toEqual(unfit);
      expect(controlIssues(cycle, control({ kind: 'pick' }), show(), at)).toEqual(unfit);
    });
  });
});
