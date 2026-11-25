// Writes documents/<kit>-stage-ci.json for the drawing kits of D-194, D-201 and D-204 that are still defined (starlight):
// labelled CI fixtures of `scroll-document.v2` Scrolls, one for each kit, for the stage
// reader's tests and screenshots. NOT product content: their titles, kickers and ids say so, and
// they are never imported into the library. They are shorter than a Scroll may be (the reading
// time is outside the 3 to 6 minutes), so they are validated without the stored measures and hash
// rules; the file itself carries both, correct. Run it with the built package:
//   pnpm --filter @knowscroll/scroll-model build && node packages/scroll-model/fixtures/regenerate-kits-v2.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyKitPatch,
  computeIntegrityV2,
  computeMeasuresV2,
  INTEGRITY_METHOD,
  kitDefinition,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_LIMITS_V2_VERSION,
  validateDocumentV2,
} from '@knowscroll/scroll-model';

const directory = dirname(fileURLToPath(import.meta.url));

const read = (id, text, simple, stage, extra = {}) => ({
  stop: { kind: 'read', id, blocks: [{ type: 'paragraph', text }], simple, ...extra },
  stage,
});
const call = (id, prompt, options, explain, twist, simple) => ({
  stop: { kind: 'call_it', id, prompt, options, answer: 0, explain, twist, simple },
});
const finalCall = (id, prompt, options, explain, twist, simple) => ({
  stop: { kind: 'final_call', id, prompt, options, answer: 0, explain, twist, simple },
});

const fixtures = {
  starlight: {
    kit: 'starlight.v1',
    title: 'The light of a star (a CI fixture)',
    dek: 'Colour, output, distance, a chart of stars and the habitable zone, in short steps (a CI fixture).',
    aside: {
      after: 'zone',
      title: 'Where this stops',
      text: 'The stars here are illustrative kinds, not named stars, and the zone’s edges depend on models. Being in a zone means that liquid water could be possible, not that a planet has water or life.',
    },
    captions: [
      'A hotter surface looks bluer.',
      'Output follows size and temperature, and thins with distance.',
      'A brighter star has a zone farther out.',
    ],
    items: [
      read(
        'colour',
        'The hotter the surface of a star, the shorter the wavelength where it shines most strongly, and the bluer it looks. The colours here are strengthened so that they can be told apart.',
        'A hotter surface looks bluer.',
        { view: 'colour', star: 'sun-like', focus: 'spectrum' },
        { emphasis: 'hook' },
      ),
      call(
        'call-colour',
        'Which star has the hotter surface?',
        ['The blue-white star', 'The red-orange star'],
        'The hotter the surface, the shorter the wavelength of its strongest glow, so the bluer the star.',
        'Red feels hot, because of fire, but the hottest stars are blue-white.',
        'Blue-white is hotter than red-orange.',
      ),
      read(
        'giant',
        'A star’s output depends on its size and its temperature together. This red giant is cooler than the Sun yet gives out far more light, because its surface is so large.',
        'Size and temperature decide the output together.',
        { view: 'output', star: 'giant', focus: 'size' },
      ),
      read(
        'dwarf',
        'A white dwarf is hotter than the Sun but tiny, so its total output is far less. The bars are on a stretched scale, each step ten times.',
        'Hot but tiny means dim.',
        { star: 'white-dwarf', focus: 'output' },
      ),
      read(
        'dimming',
        'Distance dims a star. The same light spreads over more area as it travels, so at twice the distance a square catches a quarter of the light.',
        'At twice the distance, a quarter of the light.',
        { view: 'dimming', distance: 'middle', focus: 'looks' },
      ),
      call(
        'call-dimming',
        'A star is four times as far away. How bright does it look?',
        ['A sixteenth as bright', 'A quarter as bright'],
        'The light spreads over the square of the distance, and four squared is sixteen.',
        'A quarter is the natural guess, because the distance is four. The area goes as the square.',
        'A sixteenth as bright.',
      ),
      read(
        'chart',
        'Plot output against temperature and the stars sort into groups. Most lie on the main sequence, giants above it and white dwarfs below. A star’s place suggests its kind and stage.',
        'Output against temperature sorts the stars.',
        { view: 'diagram', star: 'sun-like', focus: 'main-sequence' },
      ),
      read(
        'zone',
        'Round each star lies a zone where a planet’s surface could hold liquid water, if its air and other conditions allow. The brighter the star, the farther out its zone and the wider it is.',
        'A brighter star has a zone farther out.',
        { view: 'zone', star: 'sun-like', orbit: 'none', focus: 'zone' },
      ),
      read(
        'earth',
        'A planet as far from its star as Earth is from the Sun lies in the zone of a star like the Sun, but is too hot for a brighter star and too cold for a low-mass one.',
        'The same orbit suits one star and not another.',
        { orbit: 'earth', focus: 'planet' },
      ),
      finalCall(
        'final-zone',
        'A star gives out four times as much light as the Sun. How does its zone compare with the Sun’s?',
        ['Twice as far out', 'Four times as far out'],
        'The starlight a planet gets goes as the output over the distance squared, so the zone’s distance goes as the square root of the output.',
        'Four is the number in front of you. The square root is what you want.',
        'Four times the output means twice the distance.',
      ),
    ],
  },
};

function build(name, fixture) {
  const kit = kitDefinition(fixture.kit);
  let carried = kit.initial;
  const stops = fixture.items.map((item) => item.stop);
  const states = fixture.items.flatMap((item) => {
    if (item.stage === undefined) return [];
    carried = kit.settle(applyKitPatch(kit, carried, item.stage));
    return [{ stop: item.stop.id, state: carried, alt: kit.describe(carried) }];
  });
  const aside = {
    id: 'where-this-stops',
    kind: 'limits',
    title: fixture.aside.title,
    text: fixture.aside.text,
    anchorStop: fixture.aside.after,
    collapsed: true,
  };
  const unsigned = {
    schemaVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    assetId: `ci-fixture-${name}-stage`,
    revision: 1,
    language: 'en',
    explanationUnitId: `ci-fixture-${name}-stage-unit`,
    theme: { family: 'worlds' },
    kicker: 'CI fixture · not product content',
    title: fixture.title,
    dek: fixture.dek,
    framing: { kind: 'factual' },
    misconception: { kind: 'none' },
    stage: { kit: fixture.kit, states },
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
  writeFileSync(join(directory, 'documents', `${name}-stage-ci.json`), `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${name}-stage-ci: ${document.measures.readingSeconds} s, ${states.length} states, ${document.integrity.sha256}\n`,
  );
}

for (const [name, fixture] of Object.entries(fixtures)) build(name, fixture);
