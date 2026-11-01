import { describe, expect, it } from 'vitest';
import type { UnsupportedVerdict } from '../../content/public.js';
import {
  AMBIENT_CHECK_ROLE_ID,
  ASKED_CHECK_ROLE_ID,
  FIGURE_HINT,
  figureFlags,
  mergeFlags,
  rewriteItems,
  rewriteRole,
  sentencesOf,
  supportContext,
  supportRole,
} from './answer-check.js';
import { inhabitantRole } from './inhabitant-role.js';

/** CI fixtures: invented passages about an invented moon, never library text. */
const PASSAGES = [
  { handle: 'e1', text: 'The moon of Veld drifts away from its planet by about 3.8 centimetres every year.' },
  { handle: 'e2', text: 'Lasers bounced off mirrors on the surface time the trip to a billionth of a second.' },
];

const unsupported = (number: number, kind: UnsupportedVerdict['kind']): UnsupportedVerdict => ({
  number,
  verdict: 'unsupported',
  kind,
  problem: 'The checker’s own words, which no writer is ever shown.',
});

describe('the sentences of an answer', () => {
  it('numbers them from 1 in reading order, each resting on the passages the whole answer cites', () => {
    expect(sentencesOf({ text: 'It drifts. Lasers show it.', cites: ['e1', 'e2'] })).toEqual([
      { number: 1, text: 'It drifts.', cites: ['e1', 'e2'] },
      { number: 2, text: 'Lasers show it.', cites: ['e1', 'e2'] },
    ]);
  });
});

describe('the figure rule (D-208)', () => {
  it('flags a sentence whose figure no cited passage writes, and only that sentence', () => {
    const sentences = sentencesOf({
      text: 'The moon moves away by 3.8 centimetres every year. It moves by about 1.25 million metres each second.',
      cites: ['e1'],
    });
    expect(figureFlags(sentences, PASSAGES)).toEqual([{ number: 2, hints: [FIGURE_HINT] }]);
  });

  it('holds a sentence to the passages it cites, not to every passage offered', () => {
    const sentences = sentencesOf({ text: 'The moon moves away by 3.8 centimetres every year.', cites: ['e2'] });
    expect(figureFlags(sentences, PASSAGES)).toEqual([{ number: 1, hints: [FIGURE_HINT] }]);
  });

  it('flags nothing in a sentence without a figure', () => {
    expect(figureFlags(sentencesOf({ text: 'Lasers show the drift.', cites: ['e2'] }), PASSAGES)).toEqual([]);
  });
});

describe('what the writer is told about a flagged sentence', () => {
  it('merges the figure rule and the checker, one entry per sentence in reading order, with fixed hints only', () => {
    const flags = mergeFlags(
      [{ number: 2, hints: [FIGURE_HINT] }],
      [unsupported(3, 'goes_beyond'), unsupported(2, 'not_stated')],
    );
    expect(flags.map((flag) => flag.number)).toEqual([2, 3]);
    expect(flags[0]!.hints).toHaveLength(2);
    expect(flags[0]!.hints[0]).toBe(FIGURE_HINT);
  });

  it('shows the sentence by its own words with the hint and the draft, and never the checker’s note', () => {
    const draft = { kind: 'explanation' as const, text: 'It drifts. It is fast.', cites: ['e1'] };
    const sentences = sentencesOf(draft);
    const items = rewriteItems(sentences, mergeFlags([], [unsupported(2, 'not_stated')]), draft);
    expect(items.map((item) => item.ref)).toEqual(['check:problems', 'check:previous-draft']);
    expect(items[0]!.text).toContain('Sentence "It is fast.": No passage you cite states this.');
    expect(JSON.stringify(items)).not.toContain('the checker');
    expect(items[1]!.text).toBe(JSON.stringify(draft));
  });

  it('is a revision of the writer’s role, with no change to what it may answer', () => {
    const writer = inhabitantRole('explainer', ['e1']);
    const rewrite = rewriteRole(writer);
    expect(rewrite.id).toBe(writer.id);
    expect(rewrite.version).toBe(`${writer.version}.fix`);
    expect(rewrite.instructions.startsWith(writer.instructions)).toBe(true);
    expect(rewrite.instructions).toContain('REVISION AFTER A SUPPORT CHECK');
    expect(rewrite.outputSchema).toBe(writer.outputSchema);
  });
});

describe('the checker’s roles', () => {
  const sentences = sentencesOf({ text: 'It drifts away.', cites: ['e1'] });

  it('has a role of its own for a member’s ask and an ambient one for a resident that spoke on its own', () => {
    const asked = supportRole('asked', sentences, PASSAGES);
    const unprompted = supportRole('unprompted', sentences, PASSAGES);
    expect(asked.id).toBe(ASKED_CHECK_ROLE_ID);
    expect(asked.budgetClass).toBeUndefined();
    expect(unprompted.id).toBe(AMBIENT_CHECK_ROLE_ID);
    expect(unprompted.budgetClass).toBe('ambient');
    // The shared checker's instructions and its version are the ones an ask order's answer goes through.
    expect(asked.instructions).toBe(unprompted.instructions);
    expect(asked.version).toMatch(/^ask-support-check\./u);
  });

  it('is shown the passages the sentences cite and the sentences', () => {
    const context = supportContext('turn', 1, sentences, PASSAGES);
    expect(context.bundleRef).toBe('rooms-answer-support:turn:1');
    expect(context.items.map((item) => item.ref)).toEqual(['support:passages', 'support:sentences']);
    expect(context.items[0]!.text).toBe(`[e1] ${PASSAGES[0]!.text}`);
  });
});
