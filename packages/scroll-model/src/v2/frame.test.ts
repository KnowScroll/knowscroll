import { describe, expect, it } from 'vitest';
import { assembleScrollV2 } from '../producer/v2/assemble.js';
import { authoredV2, PUBLICATION_V2, recipeV2 } from '../test-support/v2-fixtures.js';
import { firstFrameOf, LiveStage, LiveStageFrame, Stage, StageFrame, type ScrollDocumentV2 } from './document.js';
import { STAGE_KIT_IDS } from './kits/index.js';

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
    // A state of the nerve kit has none of the fields the earth-sky kit reads; the kit name must not vouch for it.
    const other = {
      ...frame(),
      state: {
        view: 'spike',
        phase: 'rest',
        along: 'start',
        synapseAt: 'arrives',
        effect: 'excite',
        arcAt: 'sensor',
        focus: 'none',
      },
    };
    expect(StageFrame.safeParse(other).success).toBe(false);
    expect(StageFrame.safeParse({ ...frame(), kit: 'nerve.v1' }).success).toBe(false);
  });

  it('refuses an extra key, and a kit id that is not the form of one', () => {
    expect(StageFrame.safeParse({ ...frame(), stop: 'the-lean' }).success).toBe(false);
    for (const kit of ['unknown', 'constructor', 'Unknown.v1'])
      expect(StageFrame.safeParse({ ...frame(), kit }).success, kit).toBe(false);
  });

  it('takes a frame of a kit the code no longer defines, as it was stored, but never a live kit’s with a wrong state', () => {
    const stored = { kit: 'gone.v1', state: { anything: 'a word' }, alt: 'What the old kit showed.' };
    expect(StageFrame.safeParse(stored)).toEqual({ success: true, data: stored });
    expect(StageFrame.safeParse({ ...stored, kit: 'nerve.v1' }).success).toBe(false);
  });
});

describe('the first frame of a Scroll whose stage is of a kit the code no longer defines', () => {
  it('is nothing: no figure of a kit nothing can draw', () => {
    const document = fixture('stage');
    const first = document.stage?.states[0];
    if (document.stage === undefined || first === undefined) throw new Error('the stage fixture has a stage');
    const legacy = { ...document, stage: { kit: 'gone.v1', states: [{ ...first, state: { old: 'words' } }] } };
    expect(firstFrameOf(legacy as unknown as ScrollDocumentV2)).toBeUndefined();
  });
});

describe('the kits a stage frame accepts', () => {
  const kitsOf = (union: { options: readonly { shape: { kit: { value: string } } }[] }): string[] =>
    union.options.map((option) => option.shape.kit.value).sort();

  it('are exactly the kits a stage names, so a kit added to one alone fails here', () => {
    expect(kitsOf(LiveStageFrame)).toEqual(kitsOf(LiveStage));
    expect(new Set(kitsOf(LiveStage)).size).toBe(LiveStage.options.length);
  });

  it('are exactly STAGE_KIT_IDS: the kits left out of it are the ones whose stored stages are legacy', () => {
    expect(kitsOf(LiveStage)).toEqual([...STAGE_KIT_IDS].sort());
  });

  it('are all the arms of a stage but one: the last arm takes the kits that are not live', () => {
    expect(Stage.options).toHaveLength(LiveStage.options.length + 1);
    expect(StageFrame.options).toHaveLength(LiveStageFrame.options.length + 1);
  });
});
