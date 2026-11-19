import { describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX_CHARS, describePicture } from './describe.js';
import { Picture, PictureState } from './pictures.js';

const state = (raw: object = {}): PictureState => PictureState.parse(raw);

const statementNumber = Picture.parse({
  id: 'lean',
  kind: 'statement',
  title: 'Earth tilts',
  statement: { form: 'number', value: '23.4°', label: 'Earth’s lean' },
});

const statementQuote = Picture.parse({
  id: 'said',
  kind: 'statement',
  title: 'A famous line',
  caption: 'From a lecture',
  statement: { form: 'quote', text: 'Nothing is lost.', who: 'Antoine Lavoisier', work: 'Traité', year: '1789' },
});

const statementList = Picture.parse({
  id: 'kinds',
  kind: 'statement',
  title: 'Three kinds of rock',
  statement: {
    form: 'list',
    items: [
      { id: 'igneous', label: 'Igneous', note: 'Cooled from melted rock.' },
      { id: 'sedimentary', label: 'Sedimentary' },
      { id: 'metamorphic', label: 'Metamorphic' },
    ],
  },
});

const flow = Picture.parse({
  id: 'water',
  kind: 'flow',
  title: 'How water reaches a tap',
  caption: 'A simplified route',
  steps: [
    { id: 'rain', label: 'Rain falls', note: 'It lands on hills.' },
    { id: 'reservoir', label: 'A reservoir fills' },
    { id: 'plant', label: 'A plant cleans it' },
    { id: 'tap', label: 'It reaches the tap' },
  ],
});

const cycle = Picture.parse({
  id: 'seasons',
  kind: 'cycle',
  title: 'The year',
  centre: { id: 'sun', label: 'The Sun', note: 'The source of light.' },
  items: [
    { id: 'spring', label: 'Spring' },
    { id: 'summer', label: 'Summer' },
    { id: 'autumn', label: 'Autumn' },
  ],
});

const grid = Picture.parse({
  id: 'choices',
  kind: 'grid',
  title: 'Choosing a route',
  columns: [
    { id: 'fast', label: 'Fast' },
    { id: 'slow', label: 'Slow' },
  ],
  rows: [
    { id: 'cheap', label: 'Cheap' },
    { id: 'dear', label: 'Dear' },
    { id: 'free', label: 'Free' },
  ],
  cells: [
    { id: 'cheap-fast', row: 'cheap', column: 'fast', text: 'Bus', note: 'Runs every ten minutes.' },
    { id: 'cheap-slow', row: 'cheap', column: 'slow', text: 'Walk' },
    { id: 'dear-fast', row: 'dear', column: 'fast', text: 'Taxi', size: 'large' },
  ],
});

const chart = (values: 'shown' | 'hidden', extra: object = {}): Picture =>
  Picture.parse({
    id: 'daylight',
    kind: 'chart',
    title: 'Daylight in Oslo',
    form: 'bars',
    unit: 'hours',
    values,
    points: [
      { id: 'jun', label: 'June', value: '18.5', note: 'The longest day.' },
      { id: 'sep', label: 'September', value: '12' },
      { id: 'dec', label: 'December', value: '5.8' },
    ],
    marks: [
      { point: 'jun', label: 'Solstice' },
      { point: 'dec', label: 'Shortest' },
    ],
    ...extra,
  });

const plan = Picture.parse({
  id: 'soho',
  kind: 'plan',
  title: 'Soho in 1854',
  caption: 'Schematic, after John Snow’s 1855 map',
  size: { columns: 8, rows: 8 },
  ways: [
    { id: 'broad', label: 'Broad Street', from: { column: 0, row: 3 }, to: { column: 7, row: 3 } },
    { id: 'lane', from: { column: 4, row: 0 }, to: { column: 4, row: 7 } },
  ],
  places: [
    { id: 'broad-pump', label: 'Broad Street pump', at: { column: 4, row: 3 }, mark: 'ring', note: 'The suspect pump.' },
    { id: 'poland-pump', label: 'Poland Street pump', at: { column: 1, row: 1 }, mark: 'dot' },
    { id: 'rupert-pump', label: 'Rupert Street pump', at: { column: 6, row: 6 }, mark: 'dot' },
  ],
  tallies: [
    { at: { column: 4, row: 4 }, count: 10 },
    { at: { column: 3, row: 3 }, count: 20, step: 0 },
    { at: { column: 5, row: 3 }, count: 16, step: 1 },
    { at: { column: 2, row: 2 }, count: 30, step: 2 },
  ],
  steps: ['31 Aug', '1 Sep', '3 Sep'],
  regions: [
    {
      id: 'near-broad',
      label: 'Broad Street patch',
      nearest: 'broad-pump',
      among: ['broad-pump', 'poland-pump', 'rupert-pump'],
    },
  ],
  routes: [{ id: 'walk', from: 'poland-pump', to: 'broad-pump' }],
});

describe('describePicture: statement', () => {
  it('reads a number as label and value, after the title', () => {
    expect(describePicture(statementNumber, state())).toBe('Earth tilts. Earth’s lean: 23.4°.');
  });

  it('reads a quotation in typographic quotes with who, work and year, then the caption', () => {
    expect(describePicture(statementQuote, state())).toBe(
      'A famous line. “Nothing is lost.” — Antoine Lavoisier, Traité, 1789. From a lecture.',
    );
  });

  it('leaves out the work and year a quotation does not have', () => {
    const bare = Picture.parse({
      id: 'said',
      kind: 'statement',
      title: 'A line',
      statement: { form: 'quote', text: 'Stay.', who: 'Someone' },
    });
    expect(describePicture(bare, state())).toBe('A line. “Stay.” — Someone.');
  });

  it('reads a list in order', () => {
    expect(describePicture(statementList, state())).toBe(
      'Three kinds of rock. The list: Igneous, Sedimentary, Metamorphic.',
    );
  });

  it('names a lit list item as standing out and reads its note after it', () => {
    expect(describePicture(statementList, state({ lit: ['igneous'] }))).toBe(
      'Three kinds of rock. The list: Igneous, Sedimentary, Metamorphic. Standing out: Igneous. Cooled from melted rock.',
    );
  });

  it('names the lit number by its label and the lit quotation as the quotation', () => {
    expect(describePicture(statementNumber, state({ lit: ['value'] }))).toContain('Standing out: Earth’s lean.');
    expect(describePicture(statementQuote, state({ lit: ['quote'] }))).toContain('Standing out: the quotation.');
  });
});

describe('describePicture: flow', () => {
  it('reads every step in order with "then" when the state is empty', () => {
    expect(describePicture(flow, state())).toBe(
      'How water reaches a tap. Rain falls, then A reservoir fills, then A plant cleans it, then It reaches the tap. A simplified route.',
    );
  });

  it('upTo draws only the first n steps and says nothing of the rest', () => {
    const text = describePicture(flow, state({ upTo: 2 }));
    expect(text).toBe('How water reaches a tap. Rain falls, then A reservoir fills. A simplified route.');
    expect(text).not.toContain('plant');
  });

  it('reads a single step with no "then"', () => {
    expect(describePicture(flow, state({ upTo: 1 }))).toBe('How water reaches a tap. Rain falls. A simplified route.');
  });

  it('lit names the items standing out, in the order given, with notes after the names', () => {
    expect(describePicture(flow, state({ lit: ['tap', 'rain'] }))).toContain(
      'Standing out: It reaches the tap, Rain falls. Rain falls: It lands on hills. A simplified route.',
    );
  });

  it('ignores a lit step that is not yet drawn', () => {
    expect(describePicture(flow, state({ upTo: 2, lit: ['tap'] }))).not.toContain('Standing out');
  });
});

describe('describePicture: cycle', () => {
  it('reads the centre, then the ring in order and back to the first', () => {
    expect(describePicture(cycle, state())).toBe(
      'The year. At the centre: The Sun. Around it, in order: Spring, Summer, Autumn, and back to Spring.',
    );
  });

  it('does not close the ring while items are still waiting', () => {
    const text = describePicture(cycle, state({ upTo: 2 }));
    expect(text).toBe('The year. At the centre: The Sun. Around it, in order: Spring, Summer.');
  });

  it('speaks of the ring when there is no centre', () => {
    const { centre: _centre, ...ringOnly } = cycle as Extract<Picture, { kind: 'cycle' }>;
    expect(describePicture(Picture.parse(ringOnly), state())).toBe(
      'The year. Around the ring, in order: Spring, Summer, Autumn, and back to Spring.',
    );
  });

  it('lets the centre stand out whatever upTo says', () => {
    expect(describePicture(cycle, state({ upTo: 1, lit: ['sun'] }))).toContain(
      'Standing out: The Sun. The source of light.',
    );
  });
});

describe('describePicture: grid', () => {
  it('reads each row as its cells under their column names', () => {
    expect(describePicture(grid, state())).toBe(
      'Choosing a route. Cheap: Fast Bus; Slow Walk. Dear: Fast Taxi. Free: nothing.',
    );
  });

  it('upTo draws only the first n rows', () => {
    const text = describePicture(grid, state({ upTo: 1 }));
    expect(text).toBe('Choosing a route. Cheap: Fast Bus; Slow Walk.');
  });

  it('lit names a row, a column or a cell, and reads a cell note', () => {
    expect(describePicture(grid, state({ lit: ['cheap-fast'] }))).toContain(
      'Standing out: Cheap, Fast. Runs every ten minutes.',
    );
    expect(describePicture(grid, state({ lit: ['dear', 'slow'] }))).toContain('Standing out: Dear, Slow.');
  });

  it('ignores a lit row or cell of a row still waiting', () => {
    expect(describePicture(grid, state({ upTo: 1, lit: ['dear', 'dear-fast'] }))).not.toContain('Standing out');
  });
});

describe('describePicture: chart', () => {
  it('reads each point as label, value and unit, then the marks', () => {
    expect(describePicture(chart('shown'), state())).toBe(
      'Daylight in Oslo. Bar chart. June: 18.5 hours. September: 12 hours. December: 5.8 hours. Marked: June, Solstice. Marked: December, Shortest.',
    );
  });

  it('still states every value when the picture hides them', () => {
    const text = describePicture(chart('hidden'), state());
    expect(text).toContain('June: 18.5 hours.');
    expect(text).toContain('September: 12 hours.');
    expect(text).toContain('December: 5.8 hours.');
    expect(text).toContain('Marked: June, Solstice.');
  });

  it('reads a line chart as a line chart, with a unit that sticks to its figure', () => {
    const line = chart('shown', { form: 'line', unit: '%' });
    const text = describePicture(line, state());
    expect(text).toContain('Line chart.');
    expect(text).toContain('June: 18.5%.');
  });

  it('writes a figure alone when the chart has no unit', () => {
    const { unit: _unit, ...unitless } = chart('shown') as Extract<Picture, { kind: 'chart' }>;
    expect(describePicture(Picture.parse(unitless), state())).toContain('June: 18.5.');
  });

  it('upTo draws only the first n points and the marks of those points', () => {
    const text = describePicture(chart('shown'), state({ upTo: 2 }));
    expect(text).toContain('September: 12 hours.');
    expect(text).not.toContain('December');
    expect(text).toContain('Marked: June, Solstice.');
    expect(text).not.toContain('Shortest');
  });

  it('lit names a point and reads its note', () => {
    expect(describePicture(chart('hidden'), state({ lit: ['jun'] }))).toContain('Standing out: June. The longest day.');
  });
});

describe('describePicture: plan', () => {
  it('names places, ways, the marks drawn, and the routes, then the caption', () => {
    expect(describePicture(plan, state())).toBe(
      'Soho in 1854. Places: Broad Street pump, Poland Street pump, Rupert Street pump. ' +
        'Ways: Broad Street, 1 way without a name. 76 marks in all. ' +
        'A route runs from Poland Street pump to Broad Street pump. Schematic, after John Snow’s 1855 map.',
    );
  });

  it('step counts only the tallies with no step or a step up to it, and names the step', () => {
    expect(describePicture(plan, state({ step: 0 }))).toContain('By 31 Aug: 30 marks.');
    expect(describePicture(plan, state({ step: 1 }))).toContain('By 1 Sep: 46 marks.');
    expect(describePicture(plan, state({ step: 2 }))).toContain('By 3 Sep: 76 marks.');
  });

  it('says one mark in the singular', () => {
    const single = Picture.parse({ ...plan, tallies: [{ at: { column: 1, row: 1 }, count: 1 }] });
    expect(describePicture(single, state())).toContain('1 mark in all.');
  });

  it('says nothing of marks when the plan has no tallies', () => {
    const none = Picture.parse({ ...plan, tallies: [], steps: undefined });
    expect(describePicture(none, state())).not.toContain('mark');
  });

  it('region says which region is shaded and what it means', () => {
    expect(describePicture(plan, state({ region: 'near-broad' }))).toContain(
      'Shaded: Broad Street patch, the part of the plan nearer to Broad Street pump than to Poland Street pump or Rupert Street pump.',
    );
  });

  it('names a single other place without "or"', () => {
    const pair = Picture.parse({
      ...plan,
      regions: [{ id: 'near-broad', label: 'Broad Street patch', nearest: 'broad-pump', among: ['broad-pump', 'poland-pump'] }],
    });
    expect(describePicture(pair, state({ region: 'near-broad' }))).toContain('than to Poland Street pump.');
  });

  it('does not shade a region the state does not name', () => {
    expect(describePicture(plan, state())).not.toContain('Shaded');
  });

  it('lit names a place with its note, an unlabelled way as "a way", and an unlabelled route as "a route"', () => {
    expect(describePicture(plan, state({ lit: ['broad-pump'] }))).toContain(
      'Standing out: Broad Street pump. The suspect pump.',
    );
    expect(describePicture(plan, state({ lit: ['lane', 'walk'] }))).toContain('Standing out: a way, a route.');
  });

  it('describes a route with a label in brackets', () => {
    const labelled = Picture.parse({ ...plan, routes: [{ id: 'walk', label: 'Escape', from: 'poland-pump', to: 'broad-pump' }] });
    expect(describePicture(labelled, state())).toContain(
      'A route runs from Poland Street pump to Broad Street pump (Escape).',
    );
  });
});

describe('describePicture: the bound', () => {
  const crowdedChart = Picture.parse({
    id: 'crowd',
    kind: 'chart',
    title: 'A chart with a great many long labelled points',
    caption: 'The caption comes last',
    form: 'line',
    unit: 'thousand people',
    values: 'hidden',
    points: Array.from({ length: 16 }, (_, index) => ({
      id: `point-${index}`,
      label: `Year number ${index + 1}`,
      value: `${(index + 1) * 1000}`,
    })),
    marks: [],
  });

  it('cuts a long text at a sentence boundary, within the bound, and ends with an ellipsis', () => {
    const text = describePicture(crowdedChart, state());
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(text).toContain('Year number 1: 1000 thousand people.');
    expect(text).not.toContain('The caption comes last');
    // The cut text is the whole text's start, up to a sentence's end.
    const whole = describePicture(crowdedChart, state({ upTo: 4 }));
    expect(whole.length).toBeLessThan(DESCRIPTION_MAX_CHARS);
    expect(whole.endsWith('…')).toBe(false);
  });

  it('is deterministic', () => {
    expect(describePicture(crowdedChart, state())).toBe(describePicture(crowdedChart, state()));
  });
});
