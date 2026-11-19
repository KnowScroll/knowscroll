import { describe, expect, it } from 'vitest';
import { assembleScrollV2 } from '../producer/v2/assemble.js';
import { authoredV2, PUBLICATION_V2, recipeV2 } from '../test-support/v2-fixtures.js';
import { firstFrameOf, Stage, StageFrame, type ScrollDocumentV2 } from './document.js';

/** The labelled CI fixture, assembled with or without a stage. Not product content. */
function fixture(variant: 'stage' | 'plain'): ScrollDocumentV2 {
  const result = assembleScrollV2(authoredV2(variant), PUBLICATION_V2, recipeV2(variant));
  if (result.kind !== 'assembled') throw new Error('expected an assembled Scroll');
  return JSON.parse(JSON.stringify(result.document)) as ScrollDocumentV2;
}

describe('the first frame of a Scroll (what its cover shows)', () => {
  it('is the kit, state and words of the stage’s first state, without the stop it is bound to', () => {
    const document = fixture('stage');
    const first = document.stage?.states[0];
    if (document.stage === undefined || first === undefined) throw new Error('the stage fixture has a stage');
    const frame = firstFrameOf(document);
    expect(frame).toEqual({ kit: document.stage.kit, state: first.state, alt: first.alt });
    expect(Object.keys(frame ?? {}).sort()).toEqual(['alt', 'kit', 'state']);
    expect(StageFrame.safeParse(frame).success).toBe(true);
  });

  it('is nothing for a Scroll without a stage', () => {
    const document = fixture('plain');
    expect(document.stage).toBeUndefined();
    expect(firstFrameOf(document)).toBeUndefined();
  });
});

describe('a stage frame on its own', () => {
  const frame = (): { kit: string; state: unknown; alt: string } => {
    const found = firstFrameOf(fixture('stage'));
    if (found === undefined) throw new Error('the stage fixture has a frame');
    return structuredClone(found);
  };

  it('refuses a state that belongs to another kit', () => {
    // A state of the tides kit has none of the fields the earth-sky kit reads; the kit name must not vouch for it.
    const other = { ...frame(), state: { view: 'pull', moonAt: 'new', focus: 'moon' } };
    expect(StageFrame.safeParse(other).success).toBe(false);
    expect(StageFrame.safeParse({ ...frame(), kit: 'tides.v1' }).success).toBe(false);
  });

  it('refuses a kit it does not know and an extra key', () => {
    expect(StageFrame.safeParse({ ...frame(), kit: 'unknown.v1' }).success).toBe(false);
    expect(StageFrame.safeParse({ ...frame(), stop: 'the-lean' }).success).toBe(false);
  });
});

describe('the kits a stage frame accepts', () => {
  const kitsOf = (union: { options: readonly { shape: { kit: { value: string } } }[] }): string[] =>
    union.options.map((option) => option.shape.kit.value).sort();

  it('are exactly the kits a stage names, so a kit added to one alone fails here', () => {
    expect(kitsOf(StageFrame)).toEqual(kitsOf(Stage));
    expect(new Set(kitsOf(Stage)).size).toBe(Stage.options.length);
  });
});
