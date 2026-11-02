import { describe, expect, it } from 'vitest';
import { FIELD_LIMITS } from '@knowscroll/scroll-model';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import {
  closeWithCodeMadeLimits,
  isCodeMadeLimits,
  isLimitsCallout,
  isWritersLimits,
  LIMITS_TEXT,
  LIMITS_TITLE,
} from './ask-answer-limits.js';

/** Labelled CI text about an invented lighthouse: never provider output and never product content. */
type Block = AuthoredScroll['blocks'][number];
const paragraph = (text: string, cites: string[] = ['e1']): Block => ({ type: 'paragraph', cites, text });
const callout = (kind: 'limit' | 'note', title: string | undefined, text: string): Block => ({
  type: 'callout',
  cites: ['e1'],
  kind,
  ...(title === undefined ? {} : { title }),
  text,
});
const codeCallout = callout('limit', LIMITS_TITLE, LIMITS_TEXT);
const writersCallout = callout('limit', 'What this does not explain', 'Radio is not covered.');

describe('the limits callout code writes (D-371)', () => {
  it('has a title and a line that the callout schema allows and that name no subject', () => {
    expect(LIMITS_TITLE.length).toBeLessThanOrEqual(FIELD_LIMITS.calloutTitleChars);
    expect(LIMITS_TEXT.length).toBeLessThanOrEqual(FIELD_LIMITS.calloutChars);
    expect(LIMITS_TEXT).toBe("This answer uses only what the library's sources say. It may not cover every case.");
    // It must pass the schema the writer's own callout passes.
    expect(
      AuthoredScroll.safeParse({
        title: 'How a lamp guides sailors',
        dek: 'A ring of glass shapes one beam that sweeps the sea.',
        blocks: [paragraph('A ring of glass bends the light.'), codeCallout],
      }).success,
    ).toBe(true);
  });

  it('is told from the writer’s by its kind, its exact title and its exact text', () => {
    expect(isCodeMadeLimits(codeCallout)).toBe(true);
    expect(isWritersLimits(codeCallout)).toBe(false);
    expect(isCodeMadeLimits(writersCallout)).toBe(false);
    expect(isWritersLimits(writersCallout)).toBe(true);
    expect(isCodeMadeLimits(callout('note', LIMITS_TITLE, LIMITS_TEXT))).toBe(false);
    expect(isCodeMadeLimits(callout('limit', undefined, LIMITS_TEXT))).toBe(false);
    expect(isCodeMadeLimits(callout('limit', LIMITS_TITLE, `${LIMITS_TEXT} More.`))).toBe(false);
    expect(isCodeMadeLimits(paragraph(LIMITS_TEXT))).toBe(false);
    expect(isCodeMadeLimits(undefined)).toBe(false);
    expect(isLimitsCallout(callout('note', undefined, 'A note.'))).toBe(false);
    expect(isWritersLimits(callout('note', undefined, 'A note.'))).toBe(false);
  });

  it('is put last, with every limits callout of the draft taken out, and cites what the other blocks cite', () => {
    const closed = closeWithCodeMadeLimits(
      [writersCallout, paragraph('One.', ['e2', 'e1']), paragraph('Two.', ['e1', 'e3']), writersCallout],
      [0, 1, 2, 3],
      4,
    );
    expect(closed.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'callout']);
    expect(closed.blocks.at(-1)).toEqual({
      type: 'callout',
      cites: ['e2', 'e1', 'e3'],
      kind: 'limit',
      title: LIMITS_TITLE,
      text: LIMITS_TEXT,
    });
    // The blocks that stay keep the place they had; code's callout is located one past the draft.
    expect(closed.origin).toEqual([1, 2, 4]);
  });

  it('is never doubled: code’s own callout in the input is replaced, and a note callout stays', () => {
    const note = callout('note', undefined, 'A note.');
    const closed = closeWithCodeMadeLimits([paragraph('One.'), note, codeCallout], [0, 1, 2], 3);
    expect(closed.blocks.filter(isLimitsCallout)).toHaveLength(1);
    expect(closed.blocks).toContainEqual(note);
    expect(closed.blocks.at(-1)).toMatchObject({ kind: 'limit', title: LIMITS_TITLE });
  });

  it('cites at most twelve passages, the most the schema allows, and none when the answer cites nothing', () => {
    const many = Array.from({ length: 15 }, (_unused, index) => `e${String(index + 1)}`);
    const closed = closeWithCodeMadeLimits([paragraph('One.', many)], [0], 1);
    expect((closed.blocks.at(-1) as { cites: string[] }).cites).toEqual(many.slice(0, 12));
    const none = closeWithCodeMadeLimits([{ type: 'heading', text: 'The beam' }, writersCallout], [0, 1], 2);
    expect(none.blocks.map((block) => block.type)).toEqual(['heading']);
    expect(none.origin).toEqual([0]);
  });
});
