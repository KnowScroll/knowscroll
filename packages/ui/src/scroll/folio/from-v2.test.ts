import blackHole from '@knowscroll/scroll-model/fixtures/black-hole-stage-ci.json';
import circulation from '@knowscroll/scroll-model/fixtures/circulation-stage-ci.json';
import greenhouse from '@knowscroll/scroll-model/fixtures/greenhouse-stage-ci.json';
import nerve from '@knowscroll/scroll-model/fixtures/nerve-stage-ci.json';
import scaleChart from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import sortFork from '@knowscroll/scroll-model/fixtures/sort-fork-blocks-ci.json';
import starlight from '@knowscroll/scroll-model/fixtures/starlight-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { KIT_PICTURES } from '../kit';
import { drawableStage } from '../stage/stage-figure';
import { HOLD_LIMIT } from './holds';
import { readingModelOfV2 } from './from-v2';
import { beatsOf, type ReadingBlock } from './reading-model';

/** The labelled CI fixtures of `scroll-model` (not product content): every kit, and the two without a picture. */
const FIXTURES = Object.entries({
  seasons,
  greenhouse,
  circulation,
  nerve,
  starlight,
  blackHole,
  scaleChart,
  sortFork,
}).map(([name, json]) => [name, json as unknown as ScrollDocumentV2] as const);

const blocksOf = (document: ScrollDocumentV2): readonly ReadingBlock[] =>
  readingModelOfV2(document).sections.flatMap((section) => section.blocks);

describe('a v2 Scroll as an essay (folio README 5.5)', () => {
  it.each(FIXTURES)('%s: every stop is one beat, in order, named by its stop id', (_name, document) => {
    expect(beatsOf(readingModelOfV2(document)).map((beat) => beat.id)).toEqual(document.stops.map((stop) => stop.id));
  });

  it.each(FIXTURES)(
    '%s: a hold has two or three beats, two of them changing one picture that moves',
    (_name, document) => {
      for (const block of blocksOf(document)) {
        if (block.kind !== 'hold') continue;
        expect(block.beats.length).toBeGreaterThanOrEqual(2);
        expect(block.beats.length).toBeLessThanOrEqual(HOLD_LIMIT);
        expect(new Set(block.beats.map((held) => held.figure.key)).size).toBeGreaterThanOrEqual(2);
        for (const [index, held] of block.beats.entries()) {
          const before = block.beats[index - 1];
          if (before === undefined || before.figure.kind !== 'state' || held.figure.kind !== 'state') continue;
          if (before.figure.key === held.figure.key) continue;
          const kit = KIT_PICTURES[held.figure.kit];
          expect(kit.canTween(kit.sceneOf(before.figure.state), kit.sceneOf(held.figure.state))).toBe(true);
        }
      }
    },
  );

  it.each(FIXTURES)('%s: a picture appears where a stop changes it, and nowhere else', (_name, document) => {
    const changes = new Set(document.stage?.states.map((entry) => entry.stop));
    const blocks = blocksOf(document);
    const pictured = blocks.flatMap((block, index) => {
      if (block.kind === 'hold') {
        return block.beats
          .filter((held, at) => held.figure.key !== block.beats[at - 1]?.figure.key)
          .map((held) => held.beat.id);
      }
      const before = blocks[index - 1];
      return block.kind === 'figure' && before?.kind === 'beat' && block.control === undefined ? [before.beat.id] : [];
    });
    expect(new Set(pictured)).toEqual(changes);
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

  it('puts Earth with its tilt slider after a Final call that hands the tilt over (D-187)', () => {
    const document = seasons as unknown as ScrollDocumentV2;
    const final = document.stops.find((stop) => stop.kind === 'final_call');
    const blocks = blocksOf(document);
    const at = blocks.findIndex((block) => block.kind === 'beat' && block.beat.id === final?.id);
    expect(blocks[at + 1]).toMatchObject({ kind: 'figure', control: { kind: 'tilt' } });
  });

  it('draws a Scroll with no picture as beats alone, with no figure at the end', () => {
    const model = readingModelOfV2(sortFork as unknown as ScrollDocumentV2);
    expect(model.sections.flatMap((section) => section.blocks).every((block) => block.kind === 'beat')).toBe(true);
    expect(model.end.figure).toBeUndefined();
  });

  it('ends on the picture of the whole journey only where the kit draws one', () => {
    for (const [, document] of FIXTURES) {
      const stage = drawableStage(document.stage);
      const kit = stage === undefined ? undefined : KIT_PICTURES[stage.kit];
      expect(readingModelOfV2(document).end.figure?.kind).toBe(kit?.recap === undefined ? undefined : 'recap');
    }
  });

  describe('a stored Scroll whose stage is of a kit this build does not draw', () => {
    /** The seasons fixture as the library may still hold it after a kit is removed: the same stops, a stage of a kit that is gone. */
    const stored = (kit: string): ScrollDocumentV2 => {
      const original = seasons as unknown as ScrollDocumentV2;
      const states = (original.stage?.states ?? []).map((entry, index) => ({
        stop: entry.stop,
        state: { old: `word ${String(index)}` },
        alt: `What the removed kit drew, state ${String(index)}.`,
      }));
      return { ...original, stage: { kit, states } };
    };

    it.each(['gone.v1', 'constructor', '__proto__', 'toString'])(
      'reads as text, with no figure anywhere and none at the end, as a Scroll with no stage does (%s)',
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
      expect(readingModelOfV2(stored('gone.v1'))).toEqual(readingModelOfV2(withoutStage));
    });
  });
});
