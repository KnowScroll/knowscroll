import type { Claim, ProductionRecord, Source } from '../internal/provenance.js';
import type { WrittenCompileInput } from '../producer/v3/written.js';
import type { WrittenItemV3, WrittenScrollV3 } from '../producer/v3/written-schema.js';
import { beatsOfV3 } from '../v3/document.js';
import { validDocumentV3 } from './v3-fixtures.js';

/**
 * CI FIXTURES for the document v3 writer, never product content: the kettle essay of `validDocumentV3`, turned back
 * into what a model writes (no ids; pictures by number; parts by label; asides after their beat; handles for claims).
 * The layout the tests rely on, items counted from 0:
 *   0 section, 1..3 paragraphs b1..b3 (b3 scrubs), 4 aside (definition), 5 b4, 6 b5 (links 'Bubbles'), 7 aside (limits),
 *   8 section, 9..13 paragraphs b6..b10 (b6 shows picture 2).
 * Picture 1 is a flow (steps 'Cold water', 'Heat in', 'Bubbles', 'Full boil'); picture 2 a statement number (part 'value').
 * Handles: e1 the heating passage, e2 the boiling passage, e3 the steam passage.
 */

export const HEAT = 'The element of a kettle turns the electric current that passes through it into heat.';
export const BOIL = 'Pure water boils at 100 degrees Celsius at standard sea level pressure.';
export const STEAM = 'Many kettles switch themselves off when a bimetallic strip senses steam.';
/** A page the passages came from: the copy rule reads it too. */
export const PAGE =
  'Kettles are common in many homes. A long page about the history of the teapot and the samovar, with nothing in it that the essay repeats.';

export const WRITTEN_PUBLICATION = {
  assetId: 'fixture-kettle',
  revision: 1,
  language: 'en',
  explanationUnitId: 'fixture-kettle-unit',
} as const;
export const WRITTEN_PRODUCTION: ProductionRecord = { kind: 'fixture', label: 'writer v3 unit test' };

export const claimOf = (claimId: string, quote: string, sourceId: string): Claim => ({
  claimId,
  statement: quote,
  quote,
  sourceId,
  truthState: 'documented',
});
export const sourceOf = (sourceId: string): Source => ({
  sourceId,
  title: `A fictional source called ${sourceId}`,
  url: `https://example.test/${sourceId}`,
  snapshotSha256: 'a'.repeat(64),
  retrievedAt: '2026-11-01T00:00:00.000Z',
});

const HANDLE_OF_CLAIM: Readonly<Record<string, string>> = { 'c-heat': 'e1', 'c-boil': 'e2', 'c-steam': 'e3' };
const BEAT_HANDLES: Readonly<Record<string, string[]>> = { 'beat-6': ['e2'], 'beat-9': ['e3'] };

/** The kettle Scroll as the writer's one reply. The one figure in prose is `100 degrees Celsius`, spelled as the passage does. */
export function validReply(): WrittenScrollV3 {
  const document = validDocumentV3();
  const label = (id: string): string =>
    ({ heat: 'Heat in', bubbles: 'Bubbles', boil: 'Full boil', value: 'value' })[id] ?? id;
  const picturesBy = new Map(document.pictures.map((picture, index) => [picture.id, index + 1]));
  const asidesAfter = new Map<string, (typeof document.asides)[number][]>();
  for (const aside of document.asides)
    asidesAfter.set(aside.anchorBeat, [...(asidesAfter.get(aside.anchorBeat) ?? []), aside]);
  const items: WrittenItemV3[] = document.sections.flatMap((section): WrittenItemV3[] => [
    { type: 'section', title: section.title },
    ...section.beats.flatMap((beat): WrittenItemV3[] => {
      if (beat.kind !== 'plain') throw new Error('the fixture has no quotation');
      const show =
        beat.show === undefined
          ? {}
          : {
              show: {
                picture: picturesBy.get(beat.show.picture) ?? 1,
                ...(beat.show.state.upTo === undefined ? {} : { upTo: beat.show.state.upTo }),
                ...(beat.show.state.lit === undefined ? {} : { lit: beat.show.state.lit.map(label) }),
              },
            };
      const links =
        beat.links.length === 0
          ? {}
          : { links: beat.links.map((link) => ({ phrase: link.phrase, part: label(link.part) })) };
      const para: WrittenItemV3 = {
        type: 'para',
        text: beat.text.replace('one hundred degrees Celsius', '100 degrees Celsius'),
        simple: beat.simple,
        cites: BEAT_HANDLES[beat.id] ?? ['e1'],
        ...show,
        ...links,
        ...(beat.control === undefined
          ? {}
          : { control: { kind: 'scrub' as const, label: beat.control.label, along: 'steps' as const } }),
      };
      const asides = (asidesAfter.get(beat.id) ?? []).map((aside): WrittenItemV3 => ({
        type: 'aside',
        kind: aside.kind,
        title: aside.title,
        text: aside.text,
        cites: [aside.kind === 'limits' ? 'e3' : 'e1'],
      }));
      return [para, ...asides];
    }),
  ]);
  return {
    title: document.title,
    dek: document.dek,
    pictures: [
      {
        kind: 'flow',
        title: 'From cold water to a boil',
        cites: ['e1'],
        steps: [
          { label: 'Cold water', note: 'The water starts at the temperature of the room.', tone: 'cool' },
          { label: 'Heat in', note: 'The element warms the water that touches it.', tone: 'warm' },
          { label: 'Bubbles', note: 'Small bubbles of vapour form on the hot metal.' },
          { label: 'Full boil', note: 'Bubbles rise through all of the water and break.', tone: 'mark' },
        ],
      },
      {
        kind: 'statement',
        title: 'Where water boils',
        cites: ['e2'],
        statement: { form: 'number', value: '100°C', label: 'Boiling point at sea level', tone: 'warm' },
      },
    ],
    items,
    takeaway: { text: document.takeaway, cites: ['e1', 'e2'] },
    askSuggestions: document.askSuggestions,
  };
}

/** The input of a compile over the kettle Scroll: three passages with their handles, a page, and one spare claim. */
export function compileInputFor(
  reply: WrittenScrollV3,
  change: (input: Mutable) => void = () => undefined,
): WrittenCompileInput {
  const input: Mutable = {
    reply,
    code: {
      publication: WRITTEN_PUBLICATION,
      kicker: 'Fixture',
      theme: { family: 'systems' },
      shape: 'mechanism',
      framing: { kind: 'factual' },
      misconception: { kind: 'none' },
    },
    passages: { 'c-heat': HEAT, 'c-boil': BOIL, 'c-steam': STEAM },
    minDistinctCitations: 3,
    pages: [PAGE],
  };
  change(input);
  const claims = Object.entries(input.passages).map(([claimId, quote]) =>
    claimOf(claimId, quote, claimId === 'c-boil' ? 'src-b' : 'src-a'),
  );
  return {
    reply: input.reply,
    code: input.code,
    evidence: {
      claimIdOf: new Map(
        Object.entries(HANDLE_OF_CLAIM)
          .filter(([claimId]) => claimId in input.passages)
          .map(([claimId, handle]) => [handle, claimId]),
      ),
      quoteOf: new Map(Object.entries(input.passages)),
      minDistinctCitations: input.minDistinctCitations,
    },
    sources: [...Object.values(input.passages), ...input.pages],
    claims,
    sourceRecords: [sourceOf('src-a'), sourceOf('src-b')],
    production: WRITTEN_PRODUCTION,
  };
}

/** What a test may change before the input is built. */
export interface Mutable {
  reply: WrittenScrollV3;
  code: WrittenCompileInput['code'];
  passages: Record<string, string>;
  minDistinctCitations: number;
  pages: string[];
}

/** The beat count the fixture has, for tests that need to know how many paragraphs there are. */
export const FIXTURE_BEATS = beatsOfV3(validDocumentV3()).length;
