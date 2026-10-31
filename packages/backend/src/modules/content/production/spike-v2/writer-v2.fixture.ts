import { EARTH_SKY_KIT, kitDefinition, kitKeys, type StageKitId, type WordState } from '@knowscroll/scroll-model';
import { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { extractResearch, type ResearchPage } from '../../../../infrastructure/research/public-pages.js';

/**
 * CI FIXTURE, never product content and never provider output. Every sentence below is authored
 * text about an invented planet, Orrin, and its invented star, Vael. Tests use it as the source
 * pages and as the writer's recorded answer for the v2 authoring shape.
 */
export const FIXTURE_SOURCE_V2 = [
  'Orrin’s axis leans by 31 degrees, and the lean points the same way all year while the planet circles its star Vael.',
  'When Orrin’s northern half leans toward Vael, sunlight there arrives steeply and days run long, so the north warms.',
  'Half an orbit later the lean points away from Vael, sunlight arrives at a low angle and the northern days shorten.',
  'Orrin passes nearest to Vael in the middle of its southern summer, and its closest and farthest distances differ by only a few percent.',
  'A beam of light that strikes the ground at a low angle spreads over a wider patch, so each square metre receives less energy.',
  'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
  'Weather and oceans also shape local seasons, so the simple picture of lean and sunlight angle is a guide and not a full forecast.',
  'Were Orrin to stand upright with no lean at all, every place would keep much the same day length all year round.',
];

const retrievedAt = '2026-10-20T00:00:00.000Z';
const fixtureHtml = `<html><title>CI fixture</title><main>${FIXTURE_SOURCE_V2.map((text) => `<p>${text}</p>`).join('')}</main></html>`;

/** The fixture's single research page, on a host the research policy allows. */
export const fixtureResearchPageV2: ResearchPage = extractResearch(
  fixtureHtml,
  'https://spaceplace.nasa.gov/seasons/en/',
  retrievedAt,
);

/**
 * The fixture text as the page at `url`, for a recipe that names several pages. The research check refuses two
 * pages with the same text, so each page ends with one invented sentence that names its own address in letters.
 */
export function fixtureResearchPageAt(url: string): ResearchPage {
  const letters = url.replace(/[^a-z]+/giu, ' ').trim();
  const html = fixtureHtml.replace(
    '</main>',
    `<p>Orrin keeps a separate note for the page named ${letters}, which says nothing else.</p></main>`,
  );
  return extractResearch(html, url, retrievedAt);
}

/**
 * The writer's recorded answer in `scroll-authoring.v2`, written the way the v15 instructions say:
 * a stage Scroll with three calls, a limits aside, a recap and three questions, in other words than
 * the source. The picture changes on stops only and is chosen by view, month and focus (never a pin
 * or a tilt); the first call has two options with the common guess second and no number; the Final
 * call is a new case. It is valid against the fixture page above, with the seasons myth as the
 * recipe's misconception.
 */
function fixtureEarthSkyAuthoredV2(): AuthoredScrollV2 {
  return AuthoredScrollV2.parse({
    title: 'Why Orrin has summers and winters',
    dek: 'A planet that leans, a star that stays put, and a guess that most people get wrong.',
    items: [
      {
        type: 'stop',
        cites: ['e1', 'e2'],
        emphasis: 'hook',
        text: 'Orrin has long warm summers and short grey winters in the north, and the reason is not the one most people reach for first. Keep your eye on the picture while you read, because it will change with every step.',
        line: 'First, make a guess.',
        simple: 'Orrin has warm summers and cold winters. Watch the picture as you read. First, make a guess.',
        stage: { view: 'sun-earth', earthAt: 'jun', focus: 'earth' },
      },
      {
        type: 'call_it',
        cites: ['e1', 'e2', 'e4'],
        prompt: 'Why is the north of Orrin warm in midsummer?',
        options: ['Its northern half leans toward Vael', 'Orrin is closest to Vael at that moment'],
        explain:
          'The north is warm because that half of the planet leans toward Vael, so sunlight arrives steeply there. Orrin is actually nearest to its star during the southern summer, when the north is having its winter.',
        twist:
          'Most people pick the nearness answer at first, and it is easy to see why. A closer star sounds like a hotter star. The surprise is that the gap in distance is tiny, and the lean does the real work.',
        simple: 'The north is warm because it leans toward Vael. Orrin is closest to Vael in the north’s winter.',
      },
      {
        type: 'stop',
        cites: ['e4'],
        emphasis: 'turn',
        text: 'Drawn to scale, the orbit of Orrin is almost a perfect circle. The gap between its nearest and farthest points is only a few percent, far too little to explain months of heat or frost. Distance was never the lever.',
        line: 'Distance is not it.',
        simple: 'The orbit is nearly a circle, so distance cannot explain the seasons.',
        stage: { view: 'orbit', earthAt: 'jan', focus: 'orbit' },
      },
      {
        type: 'stop',
        cites: ['e1', 'e3'],
        text: 'What matters is the lean of the axis. It tips by 31 degrees and keeps pointing the same direction all year. So for part of the orbit the northern half faces toward Vael, and half an orbit later it faces away.',
        simple:
          'The axis tips and keeps pointing the same way. The north faces Vael for half the year and away for half.',
        stage: { earthAt: 'dec', focus: 'axis' },
      },
      {
        type: 'call_it',
        cites: ['e5', 'e3'],
        prompt: 'A beam hits the ground at a low angle. What happens to the patch it lights?',
        options: ['It spreads over a wider patch', 'It shrinks to a smaller patch', 'It stays exactly the same size'],
        explain:
          'A slanted beam is stretched across the ground, so the same energy is shared by a wider patch and each square metre gets less. That is why low winter sun feels weak.',
        twist:
          'Many people expect a slanted beam to be a squeezed one, and the picture is easy to get backwards. Slanting stretches the patch, and a stretched patch means thinner warmth.',
        simple: 'A low beam stretches over more ground, so each bit of ground gets less warmth.',
      },
      {
        type: 'stop',
        cites: ['e2', 'e5'],
        text: 'Meet Ray, a single beam of Vael’s light. In the north’s summer Ray arrives from high in the sky and lands on a small patch, packing its warmth into a tight space. That is a hot, long day.',
        line: 'Same sunshine, smaller patch.',
        simple: 'In summer the light comes from high up and lands on a small patch, so it feels hot.',
        stage: { view: 'earth-close', earthAt: 'jun', focus: 'ray' },
      },
      {
        type: 'stop',
        cites: ['e3', 'e5'],
        text: 'Half an orbit on, the north leans away. Ray now comes in low and spreads thin across the ground, the days shrink, and the same sunshine does far less work. Winter is not a distance problem; it is an angle problem.',
        simple: 'Later the north leans away. The light comes in low, spreads out, and the days get short.',
        stage: { earthAt: 'dec', focus: 'north-pin' },
      },
      {
        type: 'stop',
        cites: ['e6'],
        text: 'Near the equator the noon sun stays high whatever the month, so the tropics barely notice the year turning. The poles feel it most. The same lean produces very different seasons depending on where you stand.',
        simple: 'Near the equator the sun stays high all year, so the seasons barely change. The poles change most.',
        stage: { focus: 'earth' },
      },
      {
        type: 'aside',
        cites: ['e7'],
        kind: 'limits',
        title: 'Where this stops',
        text: 'This picture explains the main rhythm, not every local detail. Oceans, winds and mountains bend the seasons of each place, so treat the lean and the angle as a guide rather than a forecast.',
        collapsed: false,
      },
      {
        type: 'final_call',
        cites: ['e8', 'e1'],
        prompt: 'Imagine Orrin stood perfectly upright. What would happen to its seasons?',
        options: [
          'Day length would stay much the same, so seasons would fade',
          'Winters would get longer and colder',
          'Summers would get hotter everywhere',
        ],
        explain:
          'With no lean, no half of the planet ever tips toward the star, so day length hardly changes over the year and the seasons we know would mostly disappear.',
        twist:
          'It is tempting to think a straight planet must be extreme in some way. In fact the lean is what makes the year uneven, and removing it makes the year calm.',
        simple: 'With no lean, days stay about the same length, so there are almost no seasons.',
      },
    ],
    recap: {
      cites: ['e1', 'e5'],
      captions: [
        'The axis leans and points the same way all year.',
        'A lean changes the angle of sunlight.',
        'A low angle spreads the warmth thin.',
      ],
    },
    askSuggestions: [
      'What would seasons look like on a planet tipped on its side?',
      'Why do the tropics have almost no seasons?',
      'How much do oceans change the seasons of a place?',
    ],
  });
}

/** Every settled state of a kit, once each, in the order of its words. */
function settledStates(kit: StageKitId): WordState[] {
  const definition = kitDefinition(kit);
  const all = kitKeys(definition).reduce<WordState[]>(
    (states, key) =>
      states.flatMap((state) => (definition.enums[key] ?? []).map((word) => ({ ...state, [key]: word }))),
    [{}],
  );
  const seen = new Set<string>();
  return all
    .map(definition.settle)
    .filter((state) => !seen.has(JSON.stringify(state)) && seen.add(JSON.stringify(state)));
}

/**
 * The recorded answer for a recipe drawn with `kit`. The words are the Orrin answer's, so the text is about an
 * invented planet whatever the kit draws: the fixture proves the pipeline (the prompt's shape, the kit's words, the
 * assembled stage, the document's own admission), never that a picture matches its stop. Its six stage changes
 * are settled states spread evenly over the kit's states, each different from the one before.
 */
export function fixtureAuthoredV2(kit: StageKitId = EARTH_SKY_KIT): AuthoredScrollV2 {
  const authored = fixtureEarthSkyAuthoredV2();
  if (kit === EARTH_SKY_KIT) return authored;
  const states = settledStates(kit);
  const step = Math.floor(states.length / 6);
  let next = 0;
  return AuthoredScrollV2.parse({
    ...authored,
    items: authored.items.map((item) =>
      item.type !== 'aside' && item.stage !== undefined ? { ...item, stage: states[step * next++] } : item,
    ),
  });
}
