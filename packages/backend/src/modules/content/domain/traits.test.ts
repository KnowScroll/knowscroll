import { describe, expect, it } from 'vitest';
import { PLAY_LEVELS, traitsOfDocument } from './traits.js';

/** Labelled CI fixtures: the shape of a stored document, with only the members traits read. */
const read = { kind: 'read' };
const call = { kind: 'call_it' };
const finalCall = { kind: 'final_call' };
const v2 = (stops: readonly object[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 'scroll-document.v2',
  stops,
  misconception: { kind: 'none' },
  measures: { readingMinutes: 4.5 },
  ...extra,
});

describe('traits: the play level of a stored document (D-192)', () => {
  it('reads every v1 Scroll, a Reel and anything unrecognised as plain', () => {
    expect(traitsOfDocument({ schemaVersion: 'scroll-document.v1', measures: { readingMinutes: 3 } })).toEqual({
      playLevel: 'plain',
      readingMinutes: 3,
    });
    expect(traitsOfDocument({ schemaVersion: 'reel-document.v1' })).toEqual({ playLevel: 'plain' });
    for (const odd of [null, undefined, 'text', 7, [], {}])
      expect(traitsOfDocument(odd)).toEqual({ playLevel: 'plain' });
  });

  it('a v2 Scroll with no stage and no call is plain; a stage or a single call is stage', () => {
    expect(traitsOfDocument(v2([read, read])).playLevel).toBe('plain');
    expect(traitsOfDocument(v2([read, read], { stage: { kit: 'earth-sky' } })).playLevel).toBe('stage');
    expect(traitsOfDocument(v2([read, call, read])).playLevel).toBe('stage');
    expect(traitsOfDocument(v2([read, finalCall])).playLevel).toBe('stage');
  });

  it('a game has at least two calls and a Final call, with or without a stage', () => {
    expect(traitsOfDocument(v2([read, call, read, finalCall])).playLevel).toBe('game');
    expect(traitsOfDocument(v2([call, call, finalCall], { stage: { kit: 'earth-sky' } })).playLevel).toBe('game');
    // Two calls and no Final call is not yet a game.
    expect(traitsOfDocument(v2([read, call, call])).playLevel).toBe('stage');
  });

  it('keeps the reading minutes and the public text of the myth, and nothing of any reader', () => {
    const traits = traitsOfDocument(
      v2([read, call, finalCall], { misconception: { kind: 'myth', claim: 'The seasons come from distance.' } }),
    );
    expect(traits).toEqual({
      playLevel: 'game',
      readingMinutes: 4.5,
      misconceptionClaim: 'The seasons come from distance.',
    });
    expect(Object.keys(traits).sort()).toEqual(['misconceptionClaim', 'playLevel', 'readingMinutes']);
    expect(traitsOfDocument(v2([read])).misconceptionClaim).toBeUndefined();
  });

  it('declares the three levels in order of how much they ask', () => {
    expect(PLAY_LEVELS).toEqual(['plain', 'stage', 'game']);
  });
});
