import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION, type ScrollDocumentV3 } from '../v3/document.js';
import { SCROLL_LIMITS_V3_VERSION } from '../v3/limits.js';
import { computeMeasuresV3 } from '../v3/measures.js';
import { computeIntegrityV3 } from '../v3/validate.js';
import { INTEGRITY_METHOD } from '../document.js';

/**
 * CI FIXTURES for `scroll-document.v3`, never product content: a short, neutral explanation of how a kettle boils
 * water, written so that the words, the figures and the controls land the reading time inside the brief.
 */

/** A document without the two members code sets last: the measures and the hash. */
export type DocumentV3Parts = Omit<ScrollDocumentV3, 'measures' | 'integrity'>;

/** The fixture's pieces, before the measures and the hash are set. Beats are in two sections of five. */
function partsV3(): DocumentV3Parts {
  return {
    schemaVersion: SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
    assetId: 'fixture-kettle',
    revision: 1,
    language: 'en',
    explanationUnitId: 'fixture-kettle-unit',
    theme: { family: 'systems' },
    kicker: 'Fixture',
    title: 'How a kettle boils water',
    dek: 'Heat goes in at the bottom, and the water does the rest of the work by moving.',
    shape: 'mechanism',
    framing: { kind: 'factual' },
    misconception: { kind: 'none' },
    pictures: [
      {
        id: 'kettle-steps',
        kind: 'flow',
        title: 'From cold water to a boil',
        steps: [
          { id: 'cold', label: 'Cold water', note: 'The water starts at the temperature of the room.', tone: 'cool' },
          { id: 'heat', label: 'Heat in', note: 'The element warms the water that touches it.', tone: 'warm' },
          { id: 'bubbles', label: 'Bubbles', note: 'Small bubbles of vapour form on the hot metal.' },
          { id: 'boil', label: 'Full boil', note: 'Bubbles rise through all of the water and break.', tone: 'mark' },
        ],
      },
      {
        id: 'boil-point',
        kind: 'statement',
        title: 'Where water boils',
        statement: { form: 'number', value: '100°C', label: 'Boiling point at sea level', tone: 'warm' },
      },
    ],
    sections: [
      {
        id: 'section-heating',
        title: 'Heat goes in',
        beats: [
          {
            kind: 'plain',
            id: 'beat-1',
            text: 'Fill a kettle with cold water and switch it on. Nothing seems to happen for a while, yet energy is already flowing into the water at a steady rate, and that is where the whole story begins.',
            simple: 'A kettle starts working the moment you switch it on, even before you can see anything.',
            show: { picture: 'kettle-steps', state: { upTo: 1 } },
            links: [],
          },
          {
            kind: 'plain',
            id: 'beat-2',
            text: 'At the base of the kettle sits a metal heating element. Electric current pushes through it, and the element resists that current, so it grows hot much as a thin wire does. The element gives its heat straight to the water touching it.',
            simple: 'A hot metal part at the bottom passes its heat to the water next to it.',
            links: [{ phrase: 'heating element', part: 'heat' }],
          },
          {
            kind: 'plain',
            id: 'beat-3',
            text: 'Hot water is lighter than cold water, so the warmed layer at the bottom rises. Colder water slides down to take its place and is warmed in turn. This slow loop, called convection, spreads the heat through the whole kettle without any stirring.',
            simple: 'Warm water floats up and cooler water sinks, so the heat travels through the kettle.',
            show: { picture: 'kettle-steps', state: { upTo: 2 } },
            links: [],
            control: { kind: 'scrub', label: 'Step through the heating', along: 'steps' },
          },
          {
            kind: 'plain',
            id: 'beat-4',
            text: 'As the temperature climbs, the water gives up some of the air it was holding. You may hear a faint hiss before the first real bubbles appear. Those early bubbles are dissolved air coming out, and they are not yet boiling at all.',
            simple: 'The first tiny bubbles are air leaving the water, not boiling.',
            links: [],
          },
          {
            kind: 'plain',
            id: 'beat-5',
            text: 'Near the element the water is hottest, and there the first true bubbles form. Each one is a pocket of water vapour. It grows while the surrounding water feeds it heat, then lifts away from the metal and heads upward through the cooler water above.',
            simple: 'Real bubbles are pockets of vapour that grow on the hot metal and then float up.',
            show: { picture: 'kettle-steps', state: { upTo: 3, lit: ['bubbles'] } },
            links: [{ phrase: 'pocket of water vapour', part: 'bubbles' }],
          },
        ],
      },
      {
        id: 'section-boiling',
        title: 'The boil',
        beats: [
          {
            kind: 'plain',
            id: 'beat-6',
            text: 'Water boils when its vapour pressure matches the pressure of the air above it. At sea level that happens at one hundred degrees Celsius. Until the water reaches that temperature, bubbles that rise through it shrink and vanish before they reach the top.',
            simple: 'Water boils at a fixed temperature, which depends on the pressure of the air around it.',
            show: { picture: 'boil-point', state: { lit: ['value'] } },
            links: [],
          },
          {
            kind: 'plain',
            id: 'beat-7',
            text: 'That fixed temperature explains why a kettle stops getting hotter once it boils. Extra energy no longer raises the temperature of the water. It goes into turning liquid into steam, which carries away far more energy than hot water of the same weight holds.',
            simple: 'Once it boils, the extra heat turns water into steam instead of making it hotter.',
            links: [{ phrase: 'fixed temperature', part: 'value' }],
          },
          {
            kind: 'plain',
            id: 'beat-8',
            text: 'Higher up a mountain the air is thinner and presses less on the water, so the boiling point falls. A pot on a high peak boils at a lower temperature, which is why food cooked there takes longer, even though the water bubbles just as fiercely.',
            simple: 'On a mountain water boils at a lower temperature, so food cooks more slowly.',
            links: [],
          },
          {
            kind: 'plain',
            id: 'beat-9',
            text: 'Most kettles include a small switch that senses the stream of steam rising from the spout. When enough hot steam reaches it, a strip of two metals bends, and the bend snaps the circuit open. The element cools, and the kettle falls quiet.',
            simple: 'A steam sensor turns the kettle off when the water has boiled.',
            links: [],
          },
          {
            kind: 'plain',
            id: 'beat-10',
            text: 'So a kettle is a simple chain: current becomes heat, heat moves through the water by convection, and bubbles of vapour carry the water to its boiling point. Each step is ordinary, and together they give you a hot drink in a few minutes.',
            simple: 'Electricity makes heat, the water moves it around, and the kettle stops at the boil.',
            show: { picture: 'kettle-steps', state: { upTo: 4, lit: ['boil'] } },
            links: [],
          },
        ],
      },
    ],
    asides: [
      {
        id: 'aside-limits',
        kind: 'limits',
        title: 'Where this stops',
        text: 'This is a simplified picture. Real kettles differ in shape and power, and dissolved minerals change how bubbles form.',
        anchorBeat: 'beat-5',
        collapsed: true,
      },
      {
        id: 'aside-term',
        kind: 'definition',
        title: 'Convection',
        text: 'Heat carried by the movement of a liquid or a gas.',
        anchorBeat: 'beat-3',
        collapsed: true,
      },
    ],
    takeaway: 'A kettle turns electric current into heat, and moving water carries that heat until it boils.',
    askSuggestions: ['Why does water boil faster in a smaller pot?', 'What is steam made of?'],
    limitsVersion: SCROLL_LIMITS_V3_VERSION,
  };
}

/** Sets the measures from the document's words and figures, then the hash over everything else. */
export function sealV3(parts: DocumentV3Parts): ScrollDocumentV3 {
  const measured = { ...parts, measures: computeMeasuresV3(parts) };
  return {
    ...measured,
    integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV3({ ...measured, integrity: undefined }) },
  };
}

/** A complete, valid, hashed document v3. `overrides` replace whole members before the measures and the hash are set. */
export function validDocumentV3(overrides: Partial<DocumentV3Parts> = {}): ScrollDocumentV3 {
  return sealV3({ ...partsV3(), ...overrides });
}

/**
 * A copy of `document` after `mutate` has changed it, with the measures and the hash recomputed, so that a test breaks
 * exactly one rule and not the stored values. To break the stored values on purpose, change the result afterwards.
 */
export function withV3(document: ScrollDocumentV3, mutate: (draft: ScrollDocumentV3) => void): ScrollDocumentV3 {
  const draft = structuredClone(document);
  mutate(draft);
  return sealV3(draft);
}
