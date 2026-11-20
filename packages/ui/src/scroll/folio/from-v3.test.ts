import broadStreet from '@knowscroll/scroll-model/fixtures/broad-street-v3-ci.json';
import fence from '@knowscroll/scroll-model/fixtures/fence-v3-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import {
  orderedItems,
  type Beat,
  type PlainBeat,
  type ScrollDocumentV3,
  type SectionV3,
} from '@knowscroll/scroll-model';
import { HOLD_LIMIT } from './holds';
import { readingModelOfV3 } from './from-v3';
import { beatsOf, type ReadingBlock } from './reading-model';

/** The labelled CI fixtures of `scroll-model` (not product content), one for each kind of picture the readers draw most. */
const FIXTURES = Object.entries({ seasons, fence, broadStreet }).map(
  ([name, json]) => [name, json as unknown as ScrollDocumentV3] as const,
);

const blocksOf = (document: ScrollDocumentV3): readonly ReadingBlock[] =>
  readingModelOfV3(document).sections.flatMap((section) => section.blocks);

const documentBeats = (document: ScrollDocumentV3): readonly Beat[] =>
  document.sections.flatMap((section) => section.beats);

describe('a document v3 as an essay (folio README 3)', () => {
  it.each(FIXTURES)('%s: its sections keep their titles and ids', (_name, document) => {
    const sections = readingModelOfV3(document).sections;
    expect(sections.map((section) => section.heading)).toEqual(document.sections.map((section) => section.title));
    expect(sections.map((section) => section.id)).toEqual(document.sections.map((section) => section.id));
    for (const section of sections) expect(section.heading).toEqual(expect.any(String));
  });

  it.each(FIXTURES)('%s: every beat is drawn once, in reading order, named by its beat id', (_name, document) => {
    const ids = beatsOf(readingModelOfV3(document)).map((beat) => beat.id);
    expect(ids).toEqual(documentBeats(document).map((beat) => beat.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(FIXTURES)('%s: a hold has two or three beats and the figure changes in it', (_name, document) => {
    for (const block of blocksOf(document)) {
      if (block.kind !== 'hold') continue;
      expect(block.beats.length).toBeGreaterThanOrEqual(2);
      expect(block.beats.length).toBeLessThanOrEqual(HOLD_LIMIT);
      expect(new Set(block.beats.map((held) => held.figure.key)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(FIXTURES)('%s: a beat with a control is followed by its own figure, with that control', (_name, document) => {
    const blocks = blocksOf(document);
    const controlled = documentBeats(document).filter(
      (beat): beat is PlainBeat => beat.kind === 'plain' && beat.control !== undefined,
    );
    for (const beat of controlled) {
      const at = blocks.findIndex((block) => block.kind === 'beat' && block.beat.id === beat.id);
      expect(at).toBeGreaterThanOrEqual(0);
      const next = blocks[at + 1];
      expect(next).toMatchObject({ kind: 'figure', id: `figure-${beat.id}`, control: { kind: beat.control?.kind } });
      if (next?.kind === 'figure' && next.figure.kind === 'picture') {
        expect(next.figure.picture.id).toBe(beat.show?.picture);
        expect(next.figure.state).toEqual(beat.show?.state);
      }
    }
  });

  it.each(FIXTURES)('%s: a quote beat keeps its cite and plain beats carry none', (_name, document) => {
    const read = beatsOf(readingModelOfV3(document));
    for (const beat of documentBeats(document)) {
      const drawn = read.find((candidate) => candidate.id === beat.id);
      if (beat.kind === 'quote') expect(drawn).toMatchObject({ kind: 'quote', cite: beat.cite });
      else expect(drawn).toMatchObject({ kind: 'prose', cite: undefined });
    }
  });

  it.each(FIXTURES)('%s: a link keeps its phrase and part, in the colour its part is drawn in', (_name, document) => {
    const pictures = new Map(document.pictures.map((picture) => [picture.id, picture]));
    const read = beatsOf(readingModelOfV3(document));
    let onScreen: string | undefined;
    for (const beat of documentBeats(document)) {
      onScreen = beat.show?.picture ?? onScreen;
      const picture = onScreen === undefined ? undefined : pictures.get(onScreen);
      const drawn = read.find((candidate) => candidate.id === beat.id);
      expect(drawn?.links?.map(({ phrase, part }) => ({ phrase, part }))).toEqual(
        picture === undefined ? [] : beat.links.map(({ phrase, part }) => ({ phrase, part })),
      );
      for (const link of drawn?.links ?? []) {
        const item = picture === undefined ? undefined : orderedItems(picture).find((each) => each.id === link.part);
        if (item !== undefined) expect(link.tone).toBe(item.tone);
      }
    }
  });

  it('colours at least one link of the fixtures by its part', () => {
    const tones = FIXTURES.flatMap(([, document]) =>
      beatsOf(readingModelOfV3(document)).flatMap((beat) => (beat.links ?? []).map((link) => link.tone)),
    );
    expect(tones.some((tone) => tone === 'warm' || tone === 'cool')).toBe(true);
  });

  it.each(FIXTURES)(
    '%s: the end plate sums up with the takeaway and keeps the limits as small print',
    (_name, document) => {
      const { end } = readingModelOfV3(document);
      expect(end.takeaway).toEqual([document.takeaway]);
      const limits = document.asides.find((aside) => aside.kind === 'limits');
      expect(end.smallPrint).toEqual(limits === undefined ? undefined : { title: limits.title, text: limits.text });
    },
  );
});

/** A document of the fence fixture's pictures with the sections given, so a layout rule can be seen on its own. */
function documentOf(sections: SectionV3[]): ScrollDocumentV3 {
  return { ...(fence as unknown as ScrollDocumentV3), sections, asides: [] };
}

/** A plain beat; with a picture it shows it, revealed up to `upTo` items. */
function beat(id: string, picture?: string, upTo?: number): PlainBeat {
  return {
    kind: 'plain',
    id,
    text: `The words of ${id}.`,
    simple: `Plainer ${id}.`,
    links: [],
    ...(picture === undefined ? {} : { show: { picture, state: upTo === undefined ? {} : { upTo } } }),
  };
}

const section = (id: string, beats: PlainBeat[]): SectionV3 => ({
  id,
  title: `Section ${id}`,
  beats: [...beats],
});

describe('where a document v3 holds, and where it does not', () => {
  it('keeps the state before a beat that shows nothing, inside a run', () => {
    const [block] = readingModelOfV3(
      documentOf([section('one', [beat('a', 'road', 1), beat('b', 'road', 2), beat('c'), beat('d', 'road', 3)])]),
    ).sections.flatMap((each) => each.blocks);
    expect(block?.kind).toBe('hold');
    if (block?.kind !== 'hold') return;
    expect(block.beats.map((held) => held.beat.id)).toEqual(['a', 'b', 'c']);
    expect(block.beats[2]?.figure.key).toBe(block.beats[1]?.figure.key);
    expect(block.beats[1]?.figure.key).not.toBe(block.beats[0]?.figure.key);
  });

  it('ends a run when a beat shows another picture', () => {
    const blocks = readingModelOfV3(
      documentOf([
        section('one', [beat('a', 'road', 1), beat('b', 'road', 2), beat('c', 'costs'), beat('d', 'costs', 1)]),
      ]),
    ).sections.flatMap((each) => each.blocks);
    const holds = blocks.filter((block) => block.kind === 'hold');
    expect(holds.map((hold) => hold.beats.map((held) => held.beat.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('ends a run at the end of a section, and starts the next afresh', () => {
    const model = readingModelOfV3(
      documentOf([
        section('one', [beat('a', 'road', 1), beat('b', 'road', 2)]),
        section('two', [beat('c'), beat('d', 'road', 1), beat('e', 'road', 2)]),
      ]),
    );
    const [first, second] = model.sections;
    expect(first?.blocks.map((block) => block.kind)).toEqual(['hold']);
    // Nothing is on screen yet in the new section, so the first beat stands alone, ahead of its hold.
    expect(second?.blocks.map((block) => block.kind)).toEqual(['beat', 'hold']);
    expect(second?.blocks[0]).toMatchObject({ kind: 'beat', beat: { id: 'c' } });
  });

  it('never holds more than the limit: a fourth beat starts a new figure', () => {
    const blocks = readingModelOfV3(
      documentOf([
        section('one', [
          beat('a', 'road', 1),
          beat('b', 'road', 2),
          beat('c', 'road', 3),
          beat('d', 'road', 4),
          beat('e', 'road', 1),
        ]),
      ]),
    ).sections.flatMap((each) => each.blocks);
    for (const block of blocks) if (block.kind === 'hold') expect(block.beats.length).toBeLessThanOrEqual(HOLD_LIMIT);
    expect(blocks.filter((block) => block.kind === 'hold')[0]).toMatchObject({ beats: [{}, {}, {}] });
  });
});
