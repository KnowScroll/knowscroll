// Writes documents/seasons-stage-ci.json: a labelled CI fixture of a `scroll-document.v2` Scroll about
// the seasons, for the Stage + Spine reader's tests and screenshots. NOT product content: its title,
// kicker and ids say so, and it is never imported into the library. Run it with the built package:
//   pnpm --filter @knowscroll/scroll-model build && node packages/scroll-model/fixtures/regenerate-v2.mjs
// A test in the package re-validates the committed file with the hash and the measures checked.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeIntegrityV2,
  computeMeasuresV2,
  describeStageState,
  INTEGRITY_METHOD,
  INITIAL_STAGE_STATE,
  settleStageState,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_LIMITS_V2_VERSION,
  validateDocumentV2,
} from '@knowscroll/scroll-model';

const directory = dirname(fileURLToPath(import.meta.url));

const read = (id, blocks, emphasis, simple) => ({
  kind: 'read',
  id,
  blocks,
  ...(emphasis ? { emphasis } : {}),
  simple,
});
const line = (text) => ({ type: 'line', text });
const paragraph = (text) => ({ type: 'paragraph', text });
const heading = (text) => ({ type: 'heading', level: 2, text });

const myth = {
  kind: 'myth',
  claim: 'Earth has seasons because it is closer to the Sun in summer.',
  source: { label: 'A Private Universe (1987 documentary)', reviewed: true },
};

const stops = [
  read(
    'the-lean',
    [
      heading('It leans.'),
      paragraph(
        'Earth’s axis is tilted by 23.4 degrees. Here is the trick: it keeps pointing the same way all year, toward the North Star, however far round the Sun Earth has travelled.',
      ),
    ],
    'hook',
    'Earth is tilted, and the tilt never changes direction.',
  ),
  read(
    'same-direction',
    [
      paragraph(
        'Picture Earth at four moments of the year. In every one of them the axis leans the same way in space. What changes is where the Sun is, compared with that lean, and that is the whole story of the year.',
      ),
    ],
    undefined,
    'The tilt stays put while Earth moves around the Sun.',
  ),
  {
    kind: 'call_it',
    id: 'call-delhi',
    prompt: 'Why is June so hot in Delhi?',
    options: [
      'Earth is closer to the Sun in June',
      'Delhi’s half of Earth leans toward the Sun in June',
      'The Sun burns hotter in June',
    ],
    answer: 1,
    explain:
      'In June the northern half of Earth leans toward the Sun, so sunlight lands steeply there and the days run long.',
    twist:
      'Distance is the common guess, and it is wrong: Earth is actually closest to the Sun in early January, in the middle of northern winter.',
    simple: 'June is hot in Delhi because its half of Earth leans toward the Sun.',
    commonGuess: { option: 0, source: myth.source },
  },
  read(
    'closest-in-january',
    [
      line('Closest in early January.'),
      paragraph(
        'Earth’s orbit is almost a circle. Its nearest and farthest distances differ by only a few percent, far too little to make a winter. Here the orbit is stretched so you can see it.',
      ),
    ],
    'turn',
    'Earth is nearest the Sun in January, yet that is northern winter.',
  ),
  read(
    'steeper-light',
    [
      paragraph(
        'Sunlight that lands steeply is packed onto a small patch of ground. Sunlight that lands at a low angle is spread over a wide patch. Same Sun, same distance, different dose.',
      ),
    ],
    undefined,
    'Steep light is concentrated, low light is spread out.',
  ),
  read(
    'long-days',
    [
      paragraph(
        'The leaning half gets something else too: long days. The Sun climbs high, stays up for many hours, and has more time to warm the ground. Steep light and long days arrive together, and together they make summer.',
      ),
    ],
    undefined,
    'The leaning half gets steep light and long days.',
  ),
  {
    kind: 'call_it',
    id: 'call-december',
    prompt: 'In December, which half of Earth leans toward the Sun?',
    options: ['The northern half', 'The southern half'],
    answer: 1,
    explain: 'Half an orbit later the same lean points away from the Sun in the north and toward it in the south.',
    twist: 'Plot twist: the north did not stop leaning. The Sun moved to the other side of the lean.',
    simple: 'In December the southern half leans toward the Sun.',
  },
  read(
    'december-flips',
    [
      paragraph(
        'Half an orbit later the picture flips. The southern half leans toward the Sun, with high light and long days. The northern half is the one with low light and short days.',
      ),
    ],
    undefined,
    'In December the south is warm and the north is cool.',
  ),
  read(
    'equinox',
    [
      paragraph(
        'Twice a year Earth sits where neither half leans toward the Sun. Those are the equinoxes, in March and September. Day and night are nearly equal everywhere.',
      ),
    ],
    undefined,
    'At the equinoxes neither half leans toward the Sun.',
  ),
  read(
    'solstices',
    [
      paragraph(
        'The two moments when a half leans as far as it ever does are the solstices, in June and December. Winter and summer are not the coldest and warmest days, they are the ends of the lean.',
      ),
    ],
    undefined,
    'The solstices are when a half leans furthest.',
  ),
  read(
    'the-year',
    [
      line('The lean stays fixed.'),
      paragraph(
        'The seasons are not about distance. They are about which half of Earth leans toward the Sun, and for how long the light is steep.',
      ),
    ],
    'payoff',
    'The seasons come from the lean, not from distance.',
  ),
  {
    kind: 'final_call',
    id: 'final-tilt',
    prompt: 'Turn Earth’s tilt to 0 degrees. What happens to the seasons?',
    options: [
      'Every day is like an equinox, and the seasons almost vanish',
      'The north stays in summer all year',
      'The seasons get stronger',
    ],
    answer: 0,
    explain: 'With no tilt, neither half ever leans toward the Sun, so sunlight lands the same way all year.',
    twist: 'Most people guess that something dramatic happens. The tilt is the whole reason the year has seasons.',
    simple: 'No tilt, no seasons.',
    binding: { kind: 'tilt' },
  },
];

const aside = {
  id: 'where-this-stops',
  kind: 'limits',
  title: 'Where this stops',
  text: 'Light sets the season, but weather decides how it feels. Oceans, winds, altitude and monsoons shift the hottest weeks away from the solstice.',
  anchorStop: 'the-year',
  collapsed: true,
};
const tangent = {
  id: 'tropics-tangent',
  kind: 'tangent',
  title: 'So why do the tropics barely notice?',
  text: 'Near the equator the noon Sun stays high in every season, so the tropics change far less across the year than the poles do.',
  anchorStop: 'steeper-light',
  collapsed: true,
};

const stageAt = (stop, patch) => ({ stop, patch });
const patches = [
  stageAt('the-lean', { view: 'sun-earth', earthAt: 'jun', focus: 'axis' }),
  stageAt('same-direction', { view: 'orbit', earthAt: 'jun', focus: 'earth' }),
  stageAt('closest-in-january', { view: 'orbit-stretched', earthAt: 'jan', focus: 'orbit' }),
  stageAt('steeper-light', { view: 'earth-close', earthAt: 'jun', focus: 'ray' }),
  stageAt('december-flips', { view: 'sun-earth', earthAt: 'dec', focus: 'south-pin' }),
  stageAt('equinox', { view: 'orbit', earthAt: 'mar', focus: 'axis' }),
  stageAt('the-year', { view: 'orbit', earthAt: 'jun', focus: 'none' }),
];
let carried = INITIAL_STAGE_STATE;
const states = patches.map(({ stop, patch }) => {
  carried = settleStageState({ ...carried, ...patch });
  return { stop, state: carried, alt: describeStageState(carried) };
});

const unsigned = {
  schemaVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  assetId: 'ci-fixture-seasons-stage',
  revision: 1,
  language: 'en',
  explanationUnitId: 'ci-fixture-seasons-stage-unit',
  series: { seriesId: 'ci-fixture-seasons', part: 1 },
  theme: { family: 'worlds' },
  kicker: 'CI fixture · not product content',
  title: 'Why Earth has seasons: it leans',
  dek: 'A tilted planet and a common wrong guess about distance, in short steps (a CI fixture).',
  framing: { kind: 'factual' },
  misconception: myth,
  landmark: { key: 'the-leaning-axis', name: 'The Leaning Axis' },
  stage: { kit: 'earth-sky.v1', states },
  stops,
  asides: [tangent, aside],
  recap: {
    captions: ['The lean stays fixed.', 'Steeper light and longer days make summer.', 'Distance is not the cause.'],
    smallPrintAside: aside.id,
  },
  askSuggestions: ['What would a planet tipped on its side be like?', 'Why do the tropics have so few seasons?'],
  limitsVersion: SCROLL_LIMITS_V2_VERSION,
};
const measures = computeMeasuresV2(unsigned);
const withMeasures = { ...unsigned, measures };
const document = {
  ...withMeasures,
  integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV2(withMeasures) },
};

const outcome = validateDocumentV2(document);
if (outcome.kind !== 'valid') {
  process.stderr.write(`${JSON.stringify(outcome.issues, null, 2)}\n`);
  process.exit(1);
}
writeFileSync(join(directory, 'documents', 'seasons-stage-ci.json'), `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`seasons-stage-ci: ${measures.readingSeconds} s, ${document.integrity.sha256}\n`);
