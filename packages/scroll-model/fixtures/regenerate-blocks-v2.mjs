// Writes documents/sort-fork-blocks-ci.json and documents/scale-chart-blocks-ci.json: labelled CI fixtures of
// `scroll-document.v2` Scrolls that carry the play blocks of D-207 (a sort, a fork, a scale, a growing chart)
// and the guide, for the reader's tests, the end-to-end axe check and the block screenshots. NOT product
// content: their kickers, titles and ids say so, the subject is an invented planet, and they are never
// imported into the library. A Scroll may have two play blocks at most, so the four are split over two
// fixtures. Both are shorter than a Scroll may be (the reading time is outside the 3 to 6 minutes), so they
// are validated without the stored measures and hash rules; the file itself carries both, correct. Run it
// with the built package:
//   pnpm --filter @knowscroll/scroll-model build && node packages/scroll-model/fixtures/regenerate-blocks-v2.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeIntegrityV2,
  computeMeasuresV2,
  INTEGRITY_METHOD,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_LIMITS_V2_VERSION,
  validateDocumentV2,
} from '@knowscroll/scroll-model';

const directory = dirname(fileURLToPath(import.meta.url));

const read = (id, text, simple, extra = {}) => ({
  kind: 'read',
  id,
  blocks: [{ type: 'paragraph', text }],
  simple,
  ...extra,
});
const call = (kind, id, prompt, options, explain, twist, simple) => ({
  kind,
  id,
  prompt,
  options,
  answer: 0,
  explain,
  twist,
  simple,
});
const ray = (pose, line) => ({ character: 'ray', pose, line });

const fixtures = {
  'sort-fork-blocks': {
    title: 'Orrin’s seasons, with a sort and a fork (a CI fixture)',
    dek: 'An invented planet, a chain to put in order and two paths to choose between (a CI fixture).',
    aside: {
      after: 'chain',
      title: 'Where this stops',
      text: 'Orrin is invented for this fixture, and a real planet has more going on than one chain of causes.',
    },
    captions: ['The lean sets the season.', 'Steeper light warms.', 'Both paths meet again.'],
    stops: [
      read(
        'hook',
        'Orrin leans by 31 degrees, and the lean points the same way all year. So why does it have seasons at all?',
        'Orrin leans and has seasons.',
        { emphasis: 'hook' },
      ),
      call(
        'call_it',
        'call-guess',
        'What makes a season on Orrin?',
        ['The lean of its axis', 'Its distance from Vael'],
        'The lean changes how steeply sunlight strikes each half through the year.',
        'Distance is the natural first guess. On Orrin it hardly changes, so it cannot be the cause.',
        'The lean makes the seasons.',
      ),
      read(
        'chain',
        'Here is the chain, shuffled. Put the causes in the order they happen, from the lean to the warming of the north.',
        'Put the chain in order.',
        {
          interactive: {
            type: 'sort',
            items: [
              'The northern half warms',
              'Sunlight arrives steeply',
              'The lean points toward Vael',
              'Days run long',
            ],
            order: [2, 1, 3, 0],
            explain:
              'The lean sets the angle of the light, the angle sets how long and how strong the days are, and that warms the north.',
          },
        },
      ),
      read(
        'ray',
        'A low sun spreads the same light over more ground, so each patch gets less.',
        'A low sun spreads light thin.',
        { guide: ray('wonder', 'Same sunshine, more ground: that is all a low sun is.') },
      ),
      read(
        'paths',
        'Orrin has two halves, and you can follow either one through the year. Choose what to read next.',
        'Follow one half through the year.',
        {
          interactive: {
            type: 'fork',
            prompt: 'Which half do you want to follow?',
            branches: [
              { label: 'The north', text: 'The north warms while its lean points toward Vael, and its days run long.' },
              {
                label: 'The south',
                text: 'The south cools in those same months, because its lean points away and the light is low.',
              },
            ],
          },
        },
      ),
      call(
        'call_it',
        'call-tropics',
        'Which place changes least across the year?',
        ['Near the equator', 'Near a pole'],
        'Near the equator the noon sun stays high in every season.',
        'The poles feel the biggest swing, so it is easy to look for the calm elsewhere.',
        'The equator changes least.',
      ),
      read(
        'afterwards',
        'Whichever path you took, the two meet here: the lean is fixed, and the light does the rest.',
        'The paths meet here.',
        { guide: ray('smile', 'Fixed lean, moving light. See you at the end.') },
      ),
      call(
        'final_call',
        'final-flat',
        'If Orrin did not lean at all, what would happen to its seasons?',
        ['They would mostly disappear', 'They would grow stronger'],
        'Without a lean, the sun would stand at the same height all year, so the seasons would fade.',
        'It is tempting to think the lean only adds a little. It is the whole cause.',
        'No lean, no seasons.',
      ),
    ],
  },
  'scale-chart-blocks': {
    title: 'Vael’s planets, with a scale and a growing chart (a CI fixture)',
    dek: 'An invented star with three planets on a scale and a count that grows faster than you expect (a CI fixture).',
    aside: {
      after: 'count',
      title: 'Where this stops',
      text: 'The planets and the ferries are invented for this fixture; real distances are not tidy numbers.',
    },
    captions: ['Distances grow fast.', 'Counts can grow faster.', 'Place yourself, then count.'],
    stops: [
      read(
        'hook',
        'Vael has three planets, and the gap between them is bigger than it looks. Where would you stand?',
        'Vael has three planets.',
        { emphasis: 'hook' },
      ),
      call(
        'call_it',
        'call-far',
        'Is the farthest planet about twice as far as the nearest?',
        ['No, it is about ten times as far', 'Yes, about twice as far'],
        'Sarn sits ten times as far from Vael as Orrin does.',
        'Planets in drawings are crowded together. The real gaps are far wider.',
        'Sarn is about ten times as far.',
      ),
      read(
        'where',
        'Orrin is where you live. Zoom out to see how far the others are. Each tick on the line is ten times the one before it.',
        'Zoom out from Orrin.',
        {
          interactive: {
            type: 'scale',
            axis: 'log',
            unit: 'million km',
            points: [
              { label: 'Orrin', value: 120 },
              { label: 'Pell', value: 310 },
              { label: 'Sarn', value: 1200 },
            ],
            here: 0,
          },
        },
      ),
      read(
        'ray',
        'Light takes longer to reach a far planet, and it spreads over more ground on the way.',
        'Far planets get less light.',
        { guide: ray('point', 'Out here, my light is thin. Look how far it has to go.') },
      ),
      read(
        'count',
        'Now a count. On Orrin’s ferries, doubling the crates does much more than double the trips. Step through the counts.',
        'Step through the counts.',
        {
          interactive: {
            type: 'chart',
            shape: 'bars',
            unit: 'trips',
            points: [
              { label: '10 crates', value: 100 },
              { label: '100 crates', value: 10000 },
              { label: '1,000 crates', value: 1000000 },
            ],
          },
        },
      ),
      call(
        'call_it',
        'call-count',
        'Ten times the crates needs how many times the trips?',
        ['A hundred times', 'Ten times'],
        'Ten times the crates takes a hundred times the trips on Orrin’s ferries.',
        'Ten is the natural first guess. Each crate has to meet every other, so the work grows with the square.',
        'Ten times the crates, a hundred times the trips.',
      ),
      read(
        'last',
        'Distances and counts both grow in steps that surprise us. Keep an eye on the scale of every number.',
        'Check the scale of a number.',
      ),
      call(
        'final_call',
        'final-scale',
        'A new planet is a hundred times Orrin’s distance. How does that sit on the line?',
        ['Far beyond Sarn', 'Between Orrin and Pell'],
        'A hundred times is far beyond Sarn, which is only ten times as far.',
        'Planets drawn in a row look evenly spaced, so a hundred times can seem close.',
        'A hundred times is far beyond Sarn.',
      ),
    ],
  },
};

function build(name, fixture) {
  const aside = {
    id: 'where-this-stops',
    kind: 'limits',
    title: fixture.aside.title,
    text: fixture.aside.text,
    anchorStop: fixture.aside.after,
    collapsed: true,
  };
  const stops = fixture.stops;
  const unsigned = {
    schemaVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    assetId: `ci-fixture-${name}`,
    revision: 1,
    language: 'en',
    explanationUnitId: `ci-fixture-${name}-unit`,
    theme: { family: 'worlds' },
    kicker: 'CI fixture · not product content',
    title: fixture.title,
    dek: fixture.dek,
    framing: { kind: 'factual' },
    misconception: { kind: 'none' },
    stops,
    asides: [aside],
    recap: { captions: fixture.captions, smallPrintAside: aside.id },
    askSuggestions: ['What would change if the numbers were different?', 'Where does this picture stop being true?'],
    limitsVersion: SCROLL_LIMITS_V2_VERSION,
  };
  const withMeasures = { ...unsigned, measures: computeMeasuresV2(unsigned) };
  const document = {
    ...withMeasures,
    integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV2(withMeasures) },
  };
  const outcome = validateDocumentV2(document, { verify: false });
  if (outcome.kind !== 'valid') {
    process.stderr.write(`${name}: ${JSON.stringify(outcome.issues, null, 2)}\n`);
    process.exit(1);
  }
  writeFileSync(join(directory, 'documents', `${name}-ci.json`), `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${name}-ci: ${document.measures.readingSeconds} s, ${document.integrity.sha256}\n`);
}

for (const [name, fixture] of Object.entries(fixtures)) build(name, fixture);
