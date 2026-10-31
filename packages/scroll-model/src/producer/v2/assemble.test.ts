import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { authoredV2, PUBLICATION_V2, recipeV2 } from '../../test-support/v2-fixtures.js';
import { EARTH_SKY_KIT, INITIAL_STAGE_STATE } from '../../v2/kit.js';
import { isKitPatch, kitDefinition } from '../../v2/kits/index.js';
import { assembleScrollV2, shuffleOptions } from './assemble.js';
import { AuthoredScrollV2 } from './authoring-schema.js';

const assemble = (authored = authoredV2(), variant: 'stage' | 'plain' = 'stage') => {
  const result = assembleScrollV2(authored, PUBLICATION_V2, recipeV2(variant));
  if (result.kind !== 'assembled') throw new Error('expected an assembled Scroll');
  return result;
};

describe('shuffleOptions', () => {
  it('keeps the options, finds the correct one where it went and follows the common guess', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), fc.integer({ min: 2, max: 3 }), (seed, count) => {
        const options = ['correct', 'wrong one', 'wrong two'].slice(0, count);
        const guess = count - 1;
        const shuffled = shuffleOptions(options, guess, seed);
        expect([...shuffled.options].sort()).toEqual([...options].sort());
        expect(shuffled.options[shuffled.answer]).toBe('correct');
        expect(shuffled.options[shuffled.commonGuess ?? -1]).toBe(options[guess]);
        expect(shuffleOptions(options, guess, seed)).toEqual(shuffled);
      }),
    );
  });

  it('does not always put the correct option first', () => {
    const options = ['correct', 'wrong one', 'wrong two'];
    const answers = Array.from(
      { length: 60 },
      (_, index) => shuffleOptions(options, undefined, `seed-${index}`).answer,
    );
    expect(new Set(answers)).toEqual(new Set([0, 1, 2]));
  });
});

describe('assembleScrollV2', () => {
  it('assigns ids in reading order and anchors each aside to the item before it', () => {
    const { document, map } = assemble();
    expect(document.stops.map((stop) => stop.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    expect(document.asides).toHaveLength(1);
    expect(document.asides[0]).toMatchObject({ id: 'a1', anchorStop: 's8', kind: 'limits', collapsed: false });
    expect(document.recap.smallPrintAside).toBe('a1');
    expect(map.stopItem).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
    expect(map.asideItem).toEqual([8]);
  });

  it('carries unnamed stage values over, and records a state only where the picture really changes', () => {
    const patches: Record<number, object> = {
      0: { view: 'orbit' },
      2: { earthAt: 'jun' },
      3: { earthAt: 'dec' },
      5: { moonAt: 'full' },
      6: { view: 'moon-orbit' },
    };
    const authored = AuthoredScrollV2.parse({
      ...authoredV2(),
      items: authoredV2().items.map((item, index) =>
        item.type === 'aside' ? item : { ...item, stage: patches[index] },
      ),
    });
    const { document } = assemble(authored);
    // s3 repeats June; s6 sets a Moon phase in a view with no Moon, which settles away; s7 shows it.
    expect(document.stage?.states.map((state) => state.stop)).toEqual(['s1', 's4', 's7']);
    expect(document.stage?.states[0]?.state).toEqual({ ...INITIAL_STAGE_STATE, view: 'orbit' });
    expect(document.stage?.states[1]?.state).toEqual({ ...INITIAL_STAGE_STATE, view: 'orbit', earthAt: 'dec' });
    expect(document.stage?.states[2]?.state).toEqual({
      view: 'moon-orbit',
      earthAt: 'mar',
      moonAt: 'full',
      focus: 'none',
    });
    expect(document.stage?.states[0]?.alt).toContain('Earth circles the Sun');
  });

  it('stores only a state the view can draw: a focus on a part that is not there settles to none', () => {
    const authored = AuthoredScrollV2.parse({
      ...authoredV2(),
      items: authoredV2().items.map((item, index) =>
        item.type === 'aside' ? item : { ...item, stage: index === 0 ? { view: 'orbit', focus: 'moon' } : undefined },
      ),
    });
    expect(assemble(authored).document.stage?.states[0]?.state.focus).toBe('none');
  });

  it('records every state of the stage with the description its physics gives, never one the writer chose', () => {
    const { document } = assemble();
    const kit = kitDefinition(document.stage?.kit ?? EARTH_SKY_KIT);
    for (const entry of document.stage?.states ?? []) expect(entry.alt).toBe(kit.describe(entry.state));
    expect(Object.keys(document.stage?.states[0]?.state ?? {}).sort()).toEqual(['earthAt', 'focus', 'moonAt', 'view']);
  });

  it('writes the description of every state itself: a description the writer supplies is no key of the kit', () => {
    expect(isKitPatch(kitDefinition(EARTH_SKY_KIT), { view: 'orbit', alt: 'Anything' })).toBe(false);
    expect(isKitPatch(kitDefinition(EARTH_SKY_KIT), { view: 'orbit' })).toBe(true);
  });

  it('leaves a plain Scroll without a stage, whatever the writer put in it', () => {
    expect(assemble(authoredV2('plain'), 'plain').document.stage).toBeUndefined();
    expect(assemble(authoredV2('stage'), 'plain').document.stage).toBeUndefined();
  });

  it('builds the heading, paragraph and line blocks of a stop in that order', () => {
    const authored = AuthoredScrollV2.parse({
      ...authoredV2(),
      items: authoredV2().items.map((item, index) =>
        index === 0 && item.type === 'stop' ? { ...item, heading: 'A heading', line: 'A line.' } : item,
      ),
    });
    const first = assemble(authored).document.stops[0];
    expect(first?.kind === 'read' && first.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'line']);
  });

  it('collapses a tangent by default and opens the other kinds', () => {
    const authored = AuthoredScrollV2.parse({
      ...authoredV2(),
      items: [
        ...authoredV2().items.slice(0, 8),
        { type: 'aside', cites: ['e2'], kind: 'tangent', title: 'A tangent', text: 'Some text.' },
        ...authoredV2().items.slice(8),
      ],
    });
    expect(assemble(authored).document.asides.map((aside) => [aside.kind, aside.collapsed])).toEqual([
      ['tangent', true],
      ['limits', false],
    ]);
  });

  it('cleans whitespace and is unaffected by line breaks inside a text', () => {
    const authored = AuthoredScrollV2.parse({
      ...authoredV2(),
      items: authoredV2().items.map((item, index) =>
        index === 2 && item.type === 'stop' ? { ...item, text: `First\n\n  sentence.\tSecond sentence.` } : item,
      ),
    });
    const stop = assemble(authored).document.stops[2];
    expect(stop?.kind === 'read' && stop.blocks[0]).toEqual({
      type: 'paragraph',
      text: 'First sentence. Second sentence.',
    });
  });

  it('sets the landmark and the Final call control from the recipe, never from the writer, and leaves both out otherwise', () => {
    const landmark = { key: 'ci-fixture-axis', name: 'The CI Fixture Axis' };
    const recipe = { ...recipeV2('stage'), landmark, finalCall: { kind: 'tilt' } } as const;
    const result = assembleScrollV2(authoredV2(), PUBLICATION_V2, recipe);
    if (result.kind !== 'assembled') throw new Error('expected an assembled Scroll');
    expect(result.document.landmark).toEqual(landmark);
    const final = result.document.stops.at(-1);
    expect(final?.kind === 'final_call' && final.binding).toEqual({ kind: 'tilt' });
    // No other stop is bound, and the model's own answer carries neither field.
    expect(
      result.document.stops.filter((stop) => stop.kind === 'final_call' && stop.binding !== undefined),
    ).toHaveLength(1);
    expect(JSON.stringify(authoredV2())).not.toMatch(/landmark|binding/u);
    const plain = assemble().document;
    expect(plain.landmark).toBeUndefined();
    expect(Object.keys(plain)).not.toContain('landmark');
    expect(JSON.stringify(plain.stops)).not.toContain('binding');
  });

  it('gives an authored list with no stop nothing to assemble', () => {
    const onlyAsides = AuthoredScrollV2.parse({
      ...authoredV2(),
      items: Array.from({ length: 6 }, () => ({
        type: 'aside',
        cites: ['e2'],
        kind: 'tangent',
        title: 'T',
        text: 'Text.',
      })),
    });
    expect(assembleScrollV2(onlyAsides, PUBLICATION_V2, recipeV2('plain')).kind).toBe('unassemblable');
  });
});
