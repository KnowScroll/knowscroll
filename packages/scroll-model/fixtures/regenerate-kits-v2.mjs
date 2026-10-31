// Writes documents/<kit>-stage-ci.json for the four drawing kits of D-194 (tides, greenhouse, star,
// transit): labelled CI fixtures of `scroll-document.v2` Scrolls, one for each kit, for the stage
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
  tides: {
    kit: 'tides.v1',
    title: 'Tides: two bulges and a month (a CI fixture)',
    dek: 'The Moon’s pull, two bulges of water and the Sun’s help, in short steps (a CI fixture).',
    aside: {
      after: 'spring',
      title: 'Where this stops',
      text: 'Real tides also depend on the shape and depth of every coast and basin, which this picture leaves out.',
    },
    captions: [
      'The Moon raises two bulges.',
      'The Sun adds to them or partly cancels them.',
      'The tide swings through the month.',
    ],
    items: [
      read(
        'pull',
        'The Moon pulls on all of Earth, and not equally. The side facing the Moon is pulled hardest, the centre a little less and the far side least. The differences are enlarged here so that you can see them.',
        'The Moon pulls hardest on the near side and least on the far side.',
        { view: 'pull', focus: 'moon' },
        { emphasis: 'hook' },
      ),
      call(
        'call-where',
        'Where does the ocean bulge?',
        ['On the side facing the Moon and on the opposite side', 'Only on the side facing the Moon'],
        'Measured against Earth’s centre, the near water is pulled toward the Moon and the far water is left behind, so there are two bulges.',
        'One bulge is the natural first guess, and it is half right: the far side bulges too.',
        'Two bulges: one facing the Moon and one opposite.',
      ),
      read(
        'two',
        'The ocean stretches into two bulges along the line to the Moon, one facing it and one on the far side. The two are about equal, and the stretching is enlarged here.',
        'There are two bulges, one near the Moon and one far from it.',
        { view: 'bulges', focus: 'near-bulge' },
      ),
      read(
        'sun',
        'The Sun raises tides too, smaller ones along its own line. At new Moon the Moon is between Earth and the Sun, so the two sets of bulges lie along the same line.',
        'The Sun raises smaller bulges of its own.',
        { view: 'sun-moon', moonAt: 'new', focus: 'sun' },
      ),
      read(
        'new-line',
        'At new Moon the Moon stands on the same side of Earth as the Sun. The bulge that faces the Moon points toward both of them, and the other bulge points away from both.',
        'At new Moon the near bulge faces the Moon and the Sun.',
        { moonAt: 'new', focus: 'near-bulge' },
      ),
      read(
        'spring',
        'At full Moon the Sun, Earth and Moon are in a line again, so the bulges add up. These are the biggest tides of the month, called spring tides, and the name has nothing to do with the season.',
        'In line, the bulges add: spring tides.',
        { moonAt: 'full', focus: 'near-bulge' },
      ),
      call(
        'call-neap',
        'At first quarter, how do the Sun’s bulges and the Moon’s compare?',
        ['The Sun’s lie across the Moon’s and partly cancel them', 'They lie on top of one another and add'],
        'At the quarters the Sun and Moon stand at right angles, so the Sun’s small bulges lie across the Moon’s.',
        'Adding is what happens at new and full Moon, which makes it easy to guess here.',
        'At right angles the bulges partly cancel.',
      ),
      read(
        'neap',
        'At first quarter the Moon and the Sun are at right angles. The Sun’s small bulges lie across the Moon’s and partly cancel them, giving the smallest tides of the month, the neap tides.',
        'At right angles the bulges partly cancel: neap tides.',
        { moonAt: 'first-quarter', focus: 'none' },
      ),
      read(
        'range',
        'Through the month the size of the tide swings: biggest at new and full Moon, smallest at the quarters. The bars show the four main phases, with the Moon’s phase now marked.',
        'The tide is biggest at new and full Moon.',
        { view: 'range', moonAt: 'last-quarter', focus: 'range' },
      ),
      finalCall(
        'final-tides',
        'If the Sun’s pull on the oceans were switched off, what would happen to the difference between spring and neap tides?',
        ['It would vanish: every phase would give the same tide', 'It would grow: spring tides would be much bigger'],
        'Spring and neap tides come from the Sun’s bulges adding to the Moon’s or partly cancelling them. With no Sun bulges there is nothing to add or cancel.',
        'It is tempting to think a missing Sun would change the Moon’s tide. It would not.',
        'No Sun, no spring and neap difference.',
      ),
    ],
  },
  greenhouse: {
    kit: 'greenhouse.v1',
    title: 'Energy in, energy out (a CI fixture)',
    dek: 'Sunlight, infrared and one layer of gas, in short steps (a CI fixture).',
    aside: {
      after: 'thicker',
      title: 'Where this stops',
      text: 'This is a simple picture with one layer. The real atmosphere has many layers, and it absorbs a little of the sunlight too.',
    },
    captions: [
      'Sunlight warms the ground.',
      'A layer sends some infrared back down.',
      'Warmer ground, the same balance.',
    ],
    items: [
      read(
        'sunlight',
        'Sunlight arrives. A share of it bounces straight back to space, and the rest is taken up by the ground, which warms. The arrows are as wide as the energy they carry.',
        'Some sunlight bounces back and the rest warms the ground.',
        { view: 'sunlight', layer: 'none', change: 'settled', focus: 'sun' },
        { emphasis: 'hook' },
      ),
      call(
        'call-ground',
        'What does the warm ground do with the energy it took up?',
        ['It sends infrared, a form of heat radiation, back upward', 'It keeps all of it for good'],
        'Anything warm gives off infrared. The ground sends its energy back upward that way.',
        'Keeping it all is a natural guess, and it would mean the ground just heats up forever.',
        'The ground sends infrared back up.',
      ),
      read(
        'glow',
        'A warm ground sends infrared upward. With nothing above it, all of that infrared leaves, as much as the sunlight the ground took up. The two arrows are the same width.',
        'With no layer, as much energy leaves as arrives.',
        { view: 'infrared', focus: 'to-space' },
      ),
      read(
        'layer',
        'Now add a thin layer of gas that absorbs some of the infrared. The layer sends out infrared of its own, half up and half back down toward the ground. The rest passes straight through.',
        'A thin layer sends some infrared back down.',
        { layer: 'thin', focus: 'layer' },
      ),
      read(
        'thicker',
        'Make the layer thick and more infrared is sent back down. The ground now sends up more than the sunlight it takes up, but as much infrared leaves to space as the sunlight the ground takes up.',
        'A thick layer sends more back down.',
        { layer: 'thick', focus: 'back-down' },
      ),
      call(
        'call-energy',
        'Does the layer make energy?',
        ['No: it sends part of the infrared back', 'Yes: that is why the ground is warmer'],
        'The layer only returns part of what the ground sent. What leaves to space is always the sunlight the ground takes up, once things settle.',
        'It sounds as if a warmer ground needs extra energy from somewhere. It needs only a longer route for the energy it has.',
        'No energy is made.',
      ),
      read(
        'change',
        'Just after the layer thickens, less energy leaves than the ground takes up. For now the ground keeps the difference and warms. The gap between the two bars is that difference.',
        'At first less leaves than arrives.',
        { view: 'energy-balance', change: 'just-thickened', focus: 'to-space' },
      ),
      read(
        'settles',
        'The ground warms until the energy leaving matches the energy it takes up again. The thermometer shows the warmer ground, and the two bars are level.',
        'The ground warms until the bars match.',
        { change: 'settled', focus: 'surface' },
      ),
      finalCall(
        'final-balance',
        'The layer gets thicker still. What happens to the ground, in the end?',
        [
          'It warms further, until energy out again equals energy in',
          'It stays as warm as it was, because the layer makes no energy',
        ],
        'A thicker layer returns more infrared, so the ground has to be warmer before as much energy leaves as arrives.',
        'Because no energy is made, it is easy to think nothing can change. The route out is longer, so the ground must be warmer.',
        'A thicker layer means a warmer ground.',
      ),
    ],
  },
  star: {
    kit: 'star.v1',
    title: 'A star: pressure, mass and an ending (a CI fixture)',
    dek: 'Gravity and pressure, mass and lifetime, and two endings, in short steps (a CI fixture).',
    aside: {
      after: 'ignites',
      title: 'Where this stops',
      text: 'The masses here are classes, not figures, and the bars are on a stretched scale. Real stars vary far more than three pictures can show.',
    },
    captions: [
      'Pressure holds a star against gravity.',
      'More mass, a shorter life.',
      'The ending depends on the mass.',
    ],
    items: [
      read(
        'cloud',
        'A cloud of gas and dust collapses under its own gravity. Its centre grows denser and hotter.',
        'A cloud collapses and its centre heats.',
        { view: 'life', mass: 'sun-like', stage: 'cloud', focus: 'none' },
        { emphasis: 'hook' },
      ),
      read(
        'ignites',
        'When the core is hot enough, hydrogen fuses into helium and releases energy. That energy pushes outward as gravity pulls inward, and the star holds its size.',
        'Fusion in the core pushes out against gravity.',
        { view: 'balance', balance: 'steady', focus: 'core' },
      ),
      call(
        'call-steady',
        'What keeps a steady star from collapsing?',
        [
          'Pressure from the core’s energy pushes out as hard as gravity pulls in',
          'Nothing: it is slowly collapsing right now',
        ],
        'A star in balance has pressure pushing outward exactly as hard as gravity pulls inward.',
        'Gravity is always pulling, so it is natural to think something must give. Pressure is pushing back.',
        'Pressure balances gravity.',
      ),
      read(
        'gravity',
        'If gravity pulled harder than the pressure pushed, the star would shrink. The dashed circle is the size it was.',
        'Gravity winning means the star shrinks.',
        { balance: 'gravity-wins', focus: 'gravity' },
      ),
      read(
        'pressure',
        'If the pressure pushed harder than gravity pulled, the star would swell.',
        'Pressure winning means the star swells.',
        { balance: 'pressure-wins', focus: 'pressure' },
      ),
      read(
        'mass',
        'A more massive star squeezes its core harder and uses its fuel faster, so it shines for a much shorter time. The bars are on a stretched scale so that all three fit.',
        'More mass, a shorter life.',
        { view: 'mass', mass: 'high', focus: 'lifetime' },
      ),
      call(
        'call-lifetime',
        'Which of the three stars shines longest?',
        ['The low-mass star', 'The high-mass star'],
        'A low-mass star uses its fuel slowly, so it lasts far longer than the others.',
        'Bigger looks as if it should last longer. A bigger star burns through its fuel faster.',
        'The lightest star lasts longest.',
      ),
      read(
        'low',
        'A low-mass star swells into a giant and ends as a small, hot white dwarf, with its outer layers drifting off into space.',
        'A low-mass star ends as a white dwarf.',
        { view: 'life', mass: 'low', stage: 'end', focus: 'remnant' },
      ),
      read(
        'high',
        'A high-mass star ends in a supernova, an explosion, and leaves a small, very dense remnant.',
        'A high-mass star ends in a supernova.',
        { mass: 'high', focus: 'remnant' },
      ),
      finalCall(
        'final-ending',
        'What decides whether a star ends as a white dwarf or in a supernova?',
        ['How massive the star is', 'How old the star is when we look'],
        'The mass sets how the star ends: a low-mass star becomes a white dwarf and a high-mass one explodes.',
        'Age is a natural thing to blame, but it is the mass that sets the path.',
        'Mass sets the ending.',
      ),
    ],
  },
  transit: {
    kit: 'transit.v1',
    title: 'A planet crosses its star (a CI fixture)',
    dek: 'A dip in starlight, small and large planets, in short steps (a CI fixture).',
    aside: {
      after: 'ingress',
      title: 'Where this stops',
      text: 'The star here is an evenly bright disc and the dips are enlarged. Real stars are dimmer toward the edge, and the sizes shown are illustrative.',
    },
    captions: [
      'A planet in front of its star blocks a little light.',
      'A wider planet makes a deeper dip.',
      'The dip follows the area covered.',
    ],
    items: [
      read(
        'orbit',
        'Seen from above, a planet goes round its star. We watch from far away, so we see a dip in the light only when the planet passes between us and the star.',
        'We see a dip only when the planet passes in front.',
        { view: 'orbit', planet: 'small', at: 'before', focus: 'none' },
        { emphasis: 'hook' },
      ),
      read(
        'between',
        'Here the planet is between us and the star, so it blocks a little of the starlight.',
        'The planet in front blocks a little light.',
        { at: 'middle', focus: 'planet' },
      ),
      call(
        'call-dip',
        'What do we see as a planet crosses its star?',
        ['The star’s light dips, then returns', 'The star gets brighter'],
        'The planet covers part of the star, so less light reaches us, and the light returns once the planet has passed.',
        'Brighter is a common guess, because a planet reflects light. It is far too faint to matter here.',
        'The light dips, then returns.',
      ),
      read(
        'ingress',
        'On the star’s disc the planet has just started to cross its edge. The graph of the star’s light begins to dip, and the marker follows the planet.',
        'The graph starts to dip as the planet enters.',
        { view: 'crossing', at: 'ingress', focus: 'planet' },
      ),
      read(
        'deepest',
        'With the planet wholly in front, the dip is at its deepest. The dip is enlarged here so that it shows.',
        'The dip is deepest in the middle.',
        { at: 'middle', focus: 'dip' },
      ),
      read(
        'bigger',
        'A larger planet covers more of the star, and the dip is deeper.',
        'A larger planet makes a deeper dip.',
        { planet: 'large', focus: 'dip' },
      ),
      read(
        'compare',
        'Here the two graphs are together. The large planet is twice as wide and its dip is four times as deep, because the dip follows the area the planet covers.',
        'Twice as wide, four times as deep.',
        { view: 'compare', focus: 'dip' },
      ),
      call(
        'call-area',
        'A planet twice as wide makes a dip how much deeper?',
        ['Four times as deep', 'Twice as deep'],
        'The dip follows the area covered, and the area of a disc goes as the square of its width.',
        'Twice is the natural guess, because width doubled. Area is what counts.',
        'Four times as deep.',
      ),
      read(
        'after',
        'After the crossing the light is level again, until the planet comes round once more.',
        'The light is level again afterwards.',
        { view: 'crossing', planet: 'large', at: 'after', focus: 'none' },
      ),
      finalCall(
        'final-wide',
        'Two planets cross the same star. One’s dip is four times as deep as the other’s. How do their widths compare?',
        ['The first is twice as wide', 'The first is four times as wide'],
        'The dip goes as the square of the width, so a dip four times as deep means a planet twice as wide.',
        'Four is the number in front of you. The square root is what you want.',
        'Four times as deep means twice as wide.',
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
