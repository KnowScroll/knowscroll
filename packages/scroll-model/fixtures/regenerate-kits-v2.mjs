// Writes documents/<kit>-stage-ci.json for the drawing kits of D-194, D-201 and D-204 that are still defined (greenhouse,
// circulation, nerve, starlight, black hole): labelled CI fixtures of `scroll-document.v2` Scrolls, one for each kit, for the stage
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
  circulation: {
    kit: 'circulation.v1',
    title: 'The heart and the blood (a CI fixture)',
    dek: 'A heartbeat, two loops, pressure along a vessel and the hand-off of oxygen, in short steps (a CI fixture).',
    aside: {
      after: 'pressure',
      title: 'Where this stops',
      text: 'The picture shows average pressure and leaves out the pulse. Real vessels stretch, blood is not a simple fluid, and the colours of the blood are only a drawing convention.',
    },
    captions: [
      'The atria squeeze, then the ventricles.',
      'Pressure falls all the way round the loop.',
      'Blood gives up more oxygen where it is scarcer.',
    ],
    items: [
      read(
        'filling',
        'Between beats the heart is relaxed. Blood from the veins flows into the two upper chambers, the atria, and on through open valves into the two lower chambers, the ventricles. The valves to the arteries are shut.',
        'Between beats, blood flows into the relaxed chambers.',
        { view: 'heart', phase: 'filling', focus: 'none' },
        { emphasis: 'hook' },
      ),
      read(
        'atria',
        'The two atria squeeze together and top up the ventricles, which are still relaxed.',
        'The atria squeeze first.',
        { phase: 'atria-squeeze', focus: 'atria' },
      ),
      call(
        'call-order',
        'Which chambers squeeze first?',
        ['The two atria, then the two ventricles', 'All four at once'],
        'The atria squeeze first and top up the ventricles. Then the ventricles squeeze and push the blood out.',
        'All four at once is an easy picture of a heartbeat, but the chambers squeeze in order.',
        'The atria, then the ventricles.',
      ),
      read(
        'tense',
        'Next the ventricles begin to squeeze and their pressure climbs. The valves between the atria and ventricles snap shut. The valves to the arteries are not open yet, so no blood leaves.',
        'The ventricles tense with every valve shut.',
        { phase: 'ventricles-tense', focus: 'valves' },
      ),
      read(
        'ejection',
        'Once the pressure in the ventricles rises above the pressure in the arteries, the valves to the arteries open and blood is pushed out: from the right side to the lungs, from the left side to the rest of the body.',
        'Blood is pushed out into the arteries.',
        { phase: 'ejection', focus: 'ventricles' },
      ),
      read(
        'relaxing',
        'The ventricles relax and their pressure falls below that in the arteries, so the valves to the arteries shut. For a moment every valve is closed. Then the valves between atria and ventricles open and the beat starts again.',
        'The valves to the arteries shut and the beat starts again.',
        { phase: 'relaxing', focus: 'none' },
      ),
      read(
        'circuits',
        'The right side of the heart sends blood to the lungs, which return it to the left side. The left side sends it to the rest of the body, which returns it to the right. Red marks blood rich in oxygen and blue blood poor in it: a drawing convention.',
        'Two loops: through the lungs and through the body.',
        { view: 'circuits', focus: 'lungs' },
      ),
      call(
        'call-loops',
        'Where does the right side of the heart send blood?',
        ['To the lungs', 'To the rest of the body'],
        'The right side serves the lungs. The left side serves the rest of the body.',
        'The body is the bigger trip, so it is the natural guess, but it belongs to the left side.',
        'The right side serves the lungs.',
      ),
      read(
        'pressure',
        'Pressure is highest in the large arteries and falls all the way round the loop, because each stretch uses some of it pushing the blood through. Most of the fall is across the arterioles.',
        'Pressure falls along the loop, most across the arterioles.',
        { view: 'pressure', focus: 'arterioles' },
      ),
      read(
        'narrowed',
        'Narrow the arterioles and their resistance rises steeply. For the same flow the pressure before them is higher. The pressure after them is no higher.',
        'Narrow arterioles raise the pressure before them.',
        { vessels: 'narrowed', focus: 'arteries' },
      ),
      read(
        'oxygen-lungs',
        'In the lungs, where oxygen is plentiful, nearly all the haemoglobin in the red blood cells picks up oxygen. The curve is S-shaped: flat at the top and steep in the middle.',
        'In the lungs the haemoglobin loads up.',
        { view: 'oxygen', where: 'lungs', focus: 'curve' },
      ),
      read(
        'oxygen-rest',
        'In resting tissue oxygen is scarcer, so the blood gives up a small share of its oxygen and carries the rest on.',
        'At rest the blood gives up a little.',
        { where: 'resting-tissue', focus: 'handoff' },
      ),
      read(
        'oxygen-work',
        'In working muscle oxygen is much scarcer. The steep part of the curve means the blood gives up far more.',
        'In working muscle the blood gives up far more.',
        { where: 'active-tissue', focus: 'handoff' },
      ),
      finalCall(
        'final-oxygen',
        'Working muscle uses oxygen faster. What happens to the oxygen the blood gives up there?',
        [
          'It gives up more, because oxygen is scarcer in the tissue',
          'It gives up the same, because haemoglobin holds a fixed amount',
        ],
        'Less oxygen around the haemoglobin puts it on the steep part of the curve, so more comes off.',
        'A fixed amount is the natural guess, and the curve says otherwise.',
        'Scarcer oxygen, more handed over.',
      ),
    ],
  },
  nerve: {
    kit: 'nerve.v1',
    title: 'A nerve signal (a CI fixture)',
    dek: 'A spike, the all-or-none rule, a synapse and a reflex, in short steps (a CI fixture).',
    aside: {
      after: 'axon',
      title: 'Where this stops',
      text: 'The shapes come from a standard model of the membrane. A human neuron has other channels and numbers, and no figure is shown here.',
    },
    captions: [
      'Past the threshold a spike runs by itself.',
      'A spike is all or nothing and runs one way.',
      'A reflex loops through the spinal cord.',
    ],
    items: [
      read(
        'rest',
        'At rest the inside of a nerve cell is negative compared with the outside. Most sodium channels are shut but ready.',
        'At rest the inside of the cell is negative.',
        { view: 'spike', phase: 'rest', focus: 'trace' },
        { emphasis: 'hook' },
      ),
      read(
        'threshold',
        'A push lifts the voltage. At the threshold the cell fires by itself, and the sodium channels begin to open.',
        'At the threshold the cell fires by itself.',
        { phase: 'threshold', focus: 'threshold' },
      ),
      call(
        'call-threshold',
        'What happens once the voltage passes the threshold?',
        ['The cell fires a full spike by itself', 'The voltage rises in proportion to the push'],
        'Past the threshold, opening sodium channels let in more sodium, which opens more channels, so the spike runs on by itself.',
        'In proportion is the natural guess, but a spike is all or nothing.',
        'It fires a full spike by itself.',
      ),
      read(
        'rising',
        'Sodium channels are open and sodium ions rush in. The inside of the cell turns positive.',
        'Sodium rushes in and the voltage shoots up.',
        { phase: 'rising', focus: 'channels' },
      ),
      read(
        'falling',
        'The sodium channels shut themselves and the potassium channels are open, so potassium ions flow out and the voltage falls.',
        'Potassium flows out and the voltage falls.',
        { phase: 'falling', focus: 'channels' },
      ),
      read(
        'undershoot',
        'The potassium channels are slow to close, so the voltage dips below rest. For a moment the cell cannot fire again.',
        'The voltage dips below rest.',
        { phase: 'undershoot', focus: 'trace' },
      ),
      read(
        'all',
        'A weak push dies away. Two stronger pushes each give a spike of the same height: a spike is all or nothing.',
        'A weak push gives nothing; a strong one gives a full spike.',
        { view: 'all-or-none', focus: 'weak-push' },
      ),
      call(
        'call-same',
        'A push twice as strong as one that already fires the cell gives…',
        ['A spike of the same size', 'A spike twice as big'],
        'A spike is all or nothing. Once the cell fires, a stronger push does not make the spike bigger.',
        'Bigger input, bigger output is the usual guess, but not for a spike.',
        'A spike of the same size.',
      ),
      read(
        'axon',
        'The spike runs along the axon, away from the cell body. Behind it the membrane is recovering and cannot fire again yet, so the signal runs on in one direction.',
        'The spike runs one way along the axon.',
        { view: 'axon', along: 'middle', focus: 'recovering' },
      ),
      read(
        'release',
        'At the end of the axon the spike makes small packets release neurotransmitter into the gap.',
        'The packets release neurotransmitter.',
        { view: 'synapse', synapseAt: 'release', focus: 'vesicles' },
      ),
      read(
        'bind',
        'The neurotransmitter binds receptors on the next cell. If their channels let in ions that make the inside less negative, the voltage moves toward the threshold.',
        'This receptor moves the next cell toward the threshold.',
        { synapseAt: 'binding', effect: 'excite', focus: 'receptors' },
      ),
      read(
        'inhibit',
        'A different receptor can let in ions that make the inside more negative, so the voltage moves away from the threshold.',
        'Another receptor moves it away from the threshold.',
        { effect: 'inhibit', focus: 'receptors' },
      ),
      read(
        'reflex',
        'A reflex loops through the spinal cord, so the muscle responds while the news is still on its way up to the brain.',
        'The muscle responds before the brain is told.',
        { view: 'reflex', arcAt: 'muscle', focus: 'muscle' },
      ),
      finalCall(
        'final-reflex',
        'A reflex moves a hand away from something hot. When does the brain get the news, compared with when the muscle starts to respond?',
        ['A moment later', 'Before the muscle responds'],
        'The signal goes out to the muscle from the spinal cord straight away, and the news also climbs to the brain, which takes longer.',
        'The brain feels in charge, but the loop through the spinal cord is shorter.',
        'The muscle responds first; the brain is told a moment later.',
      ),
    ],
  },
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
  'black-hole': {
    kit: 'black-hole.v1',
    title: 'Black holes: an end, an edge and four clues (a CI fixture)',
    dek: 'How one forms, what its edge is and how we know, in short steps (a CI fixture).',
    aside: {
      after: 'size',
      title: 'Where this stops',
      text: 'The picture draws nothing at the centre, because the centre is not understood. The black holes here are illustrative, and no one clue proves a black hole by itself.',
    },
    captions: [
      'Only a massive star’s collapse can leave one.',
      'The horizon is a boundary that goes with the mass.',
      'Together, several clues make the case.',
    ],
    items: [
      read(
        'life',
        'Only a star many times the Sun’s mass can end as a black hole. In the middle of its life, fusion in the core pushes outward as hard as gravity pulls inward.',
        'A massive star holds itself up with fusion.',
        { view: 'formation', star: 'massive', stage: 'fusing', focus: 'none' },
        { emphasis: 'hook' },
      ),
      read(
        'fuel',
        'When its core fuel is used up, the pressure that held the core up falls away. Gravity wins, and the core collapses.',
        'Without fuel, gravity wins.',
        { stage: 'fuel-out', focus: 'core' },
      ),
      call(
        'call-sun',
        'Which star can end as a black hole?',
        ['A star many times the Sun’s mass', 'A star like the Sun'],
        'Only a star with far more mass than the Sun has a core that collapses this way. A star like the Sun leaves a white dwarf.',
        'The Sun is the star we know best, which makes it the easy guess. It is too light.',
        'Only a very massive star.',
      ),
      read(
        'end',
        'The collapse throws off the star’s outer layers in a supernova, and what is left of the core can be a black hole.',
        'A supernova can leave a black hole.',
        { stage: 'end', focus: 'remnant' },
      ),
      read(
        'edge',
        'The edge of a black hole is its event horizon. It is a boundary in space, not a surface. Inside it nothing can return, not even light.',
        'The horizon is a boundary, not a surface.',
        { view: 'horizon', hole: 'small', focus: 'horizon' },
      ),
      read(
        'size',
        'A black hole four times as massive has a horizon four times as wide.',
        'Four times the mass, four times the horizon.',
        { hole: 'large', focus: 'horizon' },
      ),
      read(
        'pull',
        'Far away a black hole pulls just as a star of its mass would. It does not suck in everything around it.',
        'Far away the pull is the same.',
        { view: 'pull', focus: 'hole' },
      ),
      call(
        'call-pull',
        'If the Sun were swapped for a black hole of the same mass, how would Earth’s orbit change?',
        ['It would not change', 'Earth would spiral in'],
        'Gravity far away depends on the mass and the distance only, and both are the same.',
        'Black holes have a name for swallowing things, which makes spiralling in feel likely. That is only true very close.',
        'The orbit would not change.',
      ),
      read(
        'orbits',
        'Stars that circle a point where nothing shines show that a large mass is hidden there. That is one clue.',
        'Orbits show a hidden mass.',
        { view: 'orbits', focus: 'centre' },
      ),
      read(
        'disc',
        'Gas spiralling in heats up, and the hottest gas glows in X-rays. The colours here are false, because X-rays cannot be seen.',
        'Hot gas glows in X-rays.',
        { view: 'disc', focus: 'disc' },
      ),
      read(
        'waves',
        'Two black holes that spiral together send out ripples in space. They grow stronger and quicker until the merger.',
        'Mergers send ripples through space.',
        { view: 'waves', merger: 'close', focus: 'signal' },
      ),
      read(
        'shadow',
        'Images of glowing gas show a dark patch, the black hole’s shadow. It is wider than the horizon, so it is not the horizon itself.',
        'The shadow is not the horizon.',
        { view: 'shadow', focus: 'shadow' },
      ),
      finalCall(
        'final-horizon',
        'Black hole A has twice the mass of black hole B. How do their horizons compare?',
        ['A’s is twice as wide', 'A’s is four times as wide'],
        'The horizon’s radius goes as the mass, so twice the mass means twice the radius.',
        'Four is tempting, because areas go as squares. The radius goes straight with the mass.',
        'Twice the mass, twice the horizon.',
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
