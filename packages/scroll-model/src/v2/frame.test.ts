import { describe, expect, it } from 'vitest';
import { orrinDocumentV2 } from '../test-support/v2-fixtures.js';
import { Stage, StageFrame } from './document.js';

/** The nine drawing kits a stored stage may name. None is defined by the code any more (#799, #802, #809, #832, #834, #835). */
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
] as const;

/** The first state of the stored CI fixture's stage, as a frame: the shape an older app's cover carried. */
function storedFrame(): { kit: string; state: unknown; alt: string } {
  const stage = orrinDocumentV2('stage').stage;
  const first = stage?.states[0];
  if (stage === undefined || first === undefined) throw new Error('the stage fixture has a stage');
  return { kit: stage.kit, state: first.state, alt: first.alt };
}

describe('a stage frame on its own (what an older app’s cover carried)', () => {
  it.each(RETIRED_KITS)('takes a stored frame of %s, as it was stored', (kit) => {
    const stored = { ...storedFrame(), kit };
    expect(StageFrame.safeParse(stored)).toEqual({ success: true, data: stored });
  });

  it('takes the words of any state, since no kit is left to judge them', () => {
    const stored = { kit: 'earth-sky.v1', state: { anything: 'a word' }, alt: 'What the old kit showed.' };
    expect(StageFrame.safeParse(stored)).toEqual({ success: true, data: stored });
  });

  it('refuses an extra key, and a kit id that is not the form of one', () => {
    expect(StageFrame.safeParse({ ...storedFrame(), stop: 'the-lean' }).success).toBe(false);
    for (const kit of ['unknown', 'constructor', 'Unknown.v1', '__proto__', 'gone.v1.v2', ''])
      expect(StageFrame.safeParse({ ...storedFrame(), kit }).success, kit).toBe(false);
  });

  it('needs a description of the picture, and a state that is an object', () => {
    expect(StageFrame.safeParse({ ...storedFrame(), alt: 'short' }).success).toBe(false);
    expect(StageFrame.safeParse({ ...storedFrame(), state: 'jun' }).success).toBe(false);
  });
});

describe('a stored stage', () => {
  it('takes the stage of the stored fixture whole, its kit naming a kit no code defines', () => {
    const stage = orrinDocumentV2('stage').stage;
    expect(stage?.kit).toBe('earth-sky.v1');
    expect(Stage.safeParse(stage)).toEqual({ success: true, data: stage });
  });

  it('refuses a stage whose kit is not the form of one, and one with no states', () => {
    const stage = orrinDocumentV2('stage').stage;
    expect(Stage.safeParse({ ...stage, kit: 'constructor' }).success).toBe(false);
    expect(Stage.safeParse({ ...stage, states: [] }).success).toBe(false);
  });
});
