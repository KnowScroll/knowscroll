// Writes documents/<kit>-stage-ci.json for the six drawing kits of D-194 and D-201 (tides, greenhouse, star,
// transit, circulation, nerve): labelled CI fixtures of `scroll-document.v2` Scrolls, one for each kit, for the stage
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

const OUT = 'C:/Users/XZNON/knowscroll-dev/tmp/s8b-body-kits/docs';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const everyState = (kit) => {
  const keys = Object.keys(kit.enums);
  let states = [{}];
  for (const key of keys) states = states.flatMap((state) => kit.enums[key].map((word) => ({ ...state, [key]: word })));
  return states;
};
const unique = (kit, states) => {
  const seen = new Map();
  for (const state of states) {
    const settled = kit.settle(state);
    seen.set(JSON.stringify(settled), settled);
  }
  return [...seen.values()];
};

const batches = {};
for (const id of ['circulation.v1', 'nerve.v1']) {
  const kit = kitDefinition(id);
  const settled = unique(kit, everyState(kit));
  // every picture with no focus first, then one state for each focus word, in the order the words are listed
  const plain = settled.filter((state) => state.focus === 'none');
  const focused = kit.enums.focus
    .filter((word) => word !== 'none')
    .map((word) => settled.find((state) => state.focus === word));
  const all = [...plain, ...focused.filter(Boolean)];
  const name = id.split('.')[0];
  for (let start = 0, part = 1; start < all.length; start += 11, part += 1)
    batches[`all-${name}-${part}`] = { kit: id, states: all.slice(start, start + 11) };
}

const fixtures = {};
for (const [name, batch] of Object.entries(batches)) {
  const kit = kitDefinition(batch.kit);
  const items = [];
  batch.states.forEach((state, index) => {
    items.push(read(`s${index + 1}`, 'A state of the picture, for a screenshot.', 'A state of the picture.', state));
    if (index === 1 || index === 4)
      items.push(
        call(
          `c${index}`,
          'Which?',
          ['This one', 'That one'],
          'This one, for the screenshot.',
          'Not that one.',
          'This one.',
        ),
      );
  });
  while (items.filter((item) => item.stop.kind === 'read').length < 3)
    items.push(read(`pad${items.length}`, 'A state.', 'A state.', {}));
  items.push(
    finalCall(
      'final',
      'Which?',
      ['This one', 'That one'],
      'This one, for the screenshot.',
      'Not that one.',
      'This one.',
    ),
  );
  if (items.filter((item) => item.stop.kind !== 'read').length < 3)
    items.splice(3, 0, call('c9', 'Which?', ['This one', 'That one'], 'This one.', 'Not that.', 'This one.'));
  fixtures[name] = {
    kit: batch.kit,
    title: `All states ${name} (a screenshot fixture)`,
    dek: 'Every state of the kit, for screenshots only.',
    aside: { after: 's1', title: 'Where this stops', text: 'A screenshot fixture, not product content.' },
    captions: ['One.', 'Two.', 'Three.'],
    items,
  };
}
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
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${name}-stage-ci: ${document.measures.readingSeconds} s, ${states.length} states, ${document.integrity.sha256}\n`,
  );
}

for (const [name, fixture] of Object.entries(fixtures)) build(name, fixture);
