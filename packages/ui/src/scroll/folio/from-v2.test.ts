import scaleChart from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import sortFork from '@knowscroll/scroll-model/fixtures/sort-fork-blocks-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { readingModelOfV2 } from './from-v2';
import { beatsOf, type ReadingBlock } from './reading-model';

/** The labelled CI fixtures of `scroll-model` (not product content): a stored v2 with a stage (Earth & sky), and two without one. */
const FIXTURES = Object.entries({
  seasons,
  scaleChart,
  sortFork,
}).map(([name, json]) => [name, json as unknown as ScrollDocumentV2] as const);

/** The nine drawing kits a stored stage may name; none is defined by any code any more (#799, #802, #809, #832, #834, #835). */
const RETIRED_KITS = [
  'transit.v1',
  'tides.v1',
  'star.v1',
  'greenhouse.v1',
  'circulation.v1',
  'nerve.v1',
  'black-hole.v1',
  'starlight.v1',
  'earth-sky.v1',
];

const blocksOf = (document: ScrollDocumentV2): readonly ReadingBlock[] =>
  readingModelOfV2(document).sections.flatMap((section) => section.blocks);

describe('a v2 Scroll as an essay (folio README 5.5)', () => {
  it.each(FIXTURES)('%s: every stop is one beat, in order, named by its stop id', (_name, document) => {
    expect(beatsOf(readingModelOfV2(document)).map((beat) => beat.id)).toEqual(document.stops.map((stop) => stop.id));
  });

  it.each(FIXTURES)('%s: is beats alone, with no figure, no hold and no figure at the end', (_name, document) => {
    expect(blocksOf(document).every((block) => block.kind === 'beat')).toBe(true);
    expect(readingModelOfV2(document).end.figure).toBeUndefined();
  });

  it('draws a call as its question and its explanation, with no options', () => {
    const document = seasons as unknown as ScrollDocumentV2;
    const call = document.stops.find((stop) => stop.kind === 'call_it');
    if (call === undefined || call.kind !== 'call_it') throw new Error('the fixture has a call');
    const beat = beatsOf(readingModelOfV2(document)).find((candidate) => candidate.id === call.id);
    expect(beat).toMatchObject({
      kind: 'question',
      text: [
        { kind: 'line', text: call.prompt },
        { kind: 'paragraph', text: call.explain },
      ],
    });
  });

  it('draws no slider after a Final call that stored the tilt control (D-187): the binding parses and is not acted on', () => {
    const document = seasons as unknown as ScrollDocumentV2;
    const final = document.stops.find((stop) => stop.kind === 'final_call');
    expect(final).toMatchObject({ binding: { kind: 'tilt' } });
    const blocks = blocksOf(document);
    const at = blocks.findIndex((block) => block.kind === 'beat' && block.beat.id === final?.id);
    expect(blocks.slice(at + 1).every((block) => block.kind === 'beat')).toBe(true);
    expect(blocks.some((block) => block.kind === 'figure')).toBe(false);
  });

  describe('a stored Scroll whose stage names a kit no code draws', () => {
    /** The seasons fixture with its stage rewritten: the same stops, a stage of the named kit whose states hold whatever. */
    const stored = (kit: string): ScrollDocumentV2 => {
      const original = seasons as unknown as ScrollDocumentV2;
      const states = (original.stage?.states ?? []).map((entry, index) => ({
        stop: entry.stop,
        state: { old: `word ${String(index)}` },
        alt: `What the removed kit drew, state ${String(index)}.`,
      }));
      return { ...original, stage: { kit, states } };
    };

    it.each([...RETIRED_KITS, 'gone.v1', 'constructor', '__proto__', 'toString'])(
      'reads as text, with no figure anywhere and none at the end, and never throws (%s)',
      (kit) => {
        const model = readingModelOfV2(stored(kit));
        const blocks = model.sections.flatMap((section) => section.blocks);
        expect(blocks.every((block) => block.kind === 'beat')).toBe(true);
        expect(beatsOf(model).map((beat) => beat.id)).toEqual(stored(kit).stops.map((stop) => stop.id));
        expect(model.end.figure).toBeUndefined();
      },
    );

    it('gives the same essay a Scroll without a stage gives, even with a Final call that asks for the tilt', () => {
      const withoutStage = { ...(seasons as unknown as ScrollDocumentV2) };
      delete withoutStage.stage;
      for (const kit of RETIRED_KITS) expect(readingModelOfV2(stored(kit))).toEqual(readingModelOfV2(withoutStage));
      // The fixture as it is stored, with Earth & sky's own words, reads the same.
      expect(readingModelOfV2(seasons as unknown as ScrollDocumentV2)).toEqual(readingModelOfV2(withoutStage));
    });
  });
});
