import { WrittenProseV3, WrittenScrollV3, WrittenStagingV3 } from '@knowscroll/scroll-model/producer';

/**
 * CI FIXTURE, never product content and never provider output. Every sentence below is authored text about an invented
 * planet, Orrin, and its invented star, Vael: the same invented subject as the v2 fixture, whose passages (`e1` to `e8`)
 * this reply cites. Tests use it as the writer's recorded reply in the document v3 shapes: an essay of three sections
 * with a statement picture and a grid, in the kinds the `seasons` plan names.
 */
export function fixtureReplyV3(): WrittenScrollV3 {
  return WrittenScrollV3.parse({
    title: 'Why Orrin has summers and winters',
    dek: 'A planet that leans, a star that stays put, and a guess that most people get wrong.',
    pictures: [
      {
        kind: 'statement',
        title: 'How far Orrin’s axis leans',
        cites: ['e1'],
        statement: { form: 'number', value: '31°', label: 'The lean of Orrin’s axis', tone: 'warm' },
      },
      {
        kind: 'grid',
        title: 'Which half of Orrin has which season',
        cites: ['e2', 'e3'],
        columns: [{ label: 'Leaning toward Vael' }, { label: 'Leaning away' }],
        rows: [{ label: 'Northern half' }, { label: 'Southern half' }],
        cells: [
          { row: 'Northern half', column: 'Leaning toward Vael', text: 'Long warm days', tone: 'warm' },
          { row: 'Northern half', column: 'Leaning away', text: 'Short cool days', tone: 'cool' },
          { row: 'Southern half', column: 'Leaning toward Vael', text: 'Short cool days', tone: 'cool' },
          { row: 'Southern half', column: 'Leaning away', text: 'Long warm days', tone: 'warm' },
        ],
      },
    ],
    items: [
      { type: 'section', title: 'Why distance is the wrong answer' },
      {
        type: 'para',
        text: 'Orrin has long warm summers and short grey winters in the north. Most people blame distance from its star, Vael. The real cause is an angle, and the planet’s lean explains it far better than nearness ever could.',
        simple: 'Orrin has warm summers and cold winters in the north. The cause is an angle, not distance.',
        cites: ['e1', 'e4'],
        show: { picture: 1 },
        emphasis: 'hook',
      },
      {
        type: 'para',
        text: 'Picture the orbit drawn to scale. It looks almost like a perfect circle, and from far above its nearest and farthest points would look much the same. The gap between the nearest and farthest points is tiny, far too small to turn a mild month into a frozen one. Distance cannot be the lever.',
        simple: 'The orbit is nearly a circle, so distance cannot explain the seasons.',
        cites: ['e4'],
      },
      {
        type: 'para',
        text: 'There is a stranger detail. Orrin passes closest to Vael as summer arrives in the south, which is deep winter in the north. If nearness made things hotter, the north would be warmest exactly when it is coldest.',
        simple: 'Orrin is closest to Vael in the south’s summer, when the north is cold. So nearness is not the cause.',
        cites: ['e4'],
      },
      { type: 'section', title: 'The lean and what it does to sunlight' },
      {
        type: 'para',
        text: 'What matters is the lean of the axis. It tips by 31 degrees and keeps pointing the same way all year, however far the planet travels around Vael. Think of a spinning top that never changes its tilt as it circles.',
        simple: 'The axis tips by 31 degrees and keeps pointing the same way all year.',
        cites: ['e1'],
        show: { picture: 1, lit: ['value'] },
        links: [{ phrase: '31 degrees', part: 'value' }],
      },
      {
        type: 'para',
        text: 'While the northern half leans toward Vael, sunlight lands there steeply and the days run long. The north warms. Later in the orbit the same lean points away from the star, and the picture reverses.',
        simple: 'When the north leans toward Vael it gets steep sunlight and long days. Later it leans away.',
        cites: ['e2', 'e3'],
        show: { picture: 2, upTo: 1 },
        links: [{ phrase: 'northern half', part: 'Northern half' }],
        control: { kind: 'switch', label: 'Show the southern half too', to: { upTo: 2 } },
      },
      {
        type: 'para',
        text: 'Slant is the key. A beam that arrives at a low angle is spread thin across the ground, and the ground notices.',
        simple: 'A low beam of light is spread thin across the ground.',
        cites: ['e5'],
        show: { picture: 2, upTo: 2 },
      },
      {
        type: 'quote',
        text: 'A beam of light that strikes the ground at a low angle spreads over a wider patch, so each square metre receives less energy.',
        simple: 'A low beam spreads over a wider patch, so each bit of ground gets less energy.',
        who: 'An invented field guide',
        work: 'Notes on Orrin',
        cites: ['e5'],
      },
      {
        type: 'aside',
        kind: 'limits',
        title: 'Where this stops',
        text: 'This picture explains the main rhythm of the seasons, not every local detail. Weather, oceans and mountains bend the seasons of each place, so lean and sunlight angle are a guide rather than a forecast.',
        cites: ['e7'],
      },
      {
        type: 'para',
        text: 'Day length follows the same rule. In winter the northern days shorten, and the long nights give the ground time to lose the little warmth it gained. Steep sunlight with long days adds up; low sunlight with short days subtracts.',
        simple: 'Winter days in the north are short, and the ground loses warmth in the long nights.',
        cites: ['e3'],
      },
      { type: 'section', title: 'What distance still does, and other skies' },
      {
        type: 'para',
        text: 'Distance does still count for something, though only a little. Because the nearest and farthest points differ so slightly, its effect on temperature is small next to the effect of the lean. Nearer and farther are real, just minor.',
        simple: 'Distance matters a little, but the lean matters much more.',
        cites: ['e4'],
      },
      {
        type: 'para',
        text: 'Where you stand changes the story as well. Close to the equator the midday sun is high all year, so the tropics barely notice the year turning, while the poles feel the change most. The same lean gives each latitude its own kind of year.',
        simple: 'Near the equator the sun is high all year, so the seasons barely change. The poles change most.',
        cites: ['e6'],
      },
      {
        type: 'para',
        text: 'Now imagine Orrin standing perfectly upright. Days would stay nearly the same length wherever you lived, and the seasons we know would mostly fade away. The lean makes the year uneven, and without it the calendar of the planet would go quiet.',
        simple: 'With no lean, days would stay the same length and the seasons would mostly fade.',
        cites: ['e8'],
        emphasis: 'payoff',
      },
    ],
    takeaway: {
      text: 'The seasons come from the lean of the axis, which changes the angle of sunlight and the length of the day, and not from how near the planet is to its star.',
      cites: ['e1', 'e2'],
    },
    askSuggestions: [
      'What would seasons look like on a planet tipped on its side?',
      'Why do the tropics have almost no seasons?',
    ],
  });
}

/** The same essay as arm b's first reply: no picture, no show, link, control or emphasis. */
export function fixtureProseV3(): WrittenProseV3 {
  const { pictures: _pictures, items, ...essay } = fixtureReplyV3();
  return WrittenProseV3.parse({
    ...essay,
    items: items.map((item) => {
      if (item.type === 'section' || item.type === 'aside') return item;
      const { show: _show, links: _links, ...bare } = item;
      const {
        control: _control,
        emphasis: _emphasis,
        ...prose
      } = bare as typeof bare & {
        control?: unknown;
        emphasis?: unknown;
      };
      return prose;
    }),
  });
}

/** The same essay as arm b's second reply: the pictures, and what each paragraph shows, links and controls. */
export function fixtureStagingV3(): WrittenStagingV3 {
  const { pictures, items } = fixtureReplyV3();
  const beats = items.filter((item) => item.type === 'para' || item.type === 'quote');
  const stage = beats.flatMap((beat, index) => {
    const { show, links, control, emphasis } = beat as typeof beat & { control?: unknown; emphasis?: unknown };
    if (show === undefined && links === undefined && control === undefined && emphasis === undefined) return [];
    return [
      {
        para: index + 1,
        ...(show === undefined ? {} : { show }),
        ...(links === undefined ? {} : { links }),
        ...(control === undefined ? {} : { control }),
        ...(emphasis === undefined ? {} : { emphasis }),
      },
    ];
  });
  return WrittenStagingV3.parse({ pictures, stage });
}
