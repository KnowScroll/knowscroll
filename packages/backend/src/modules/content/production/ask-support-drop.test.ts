import { describe, expect, it } from 'vitest';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { MIN_SERVED_SENTENCES, type SentenceVerdict } from '../domain/ask-support.js';
import { dropFlagged } from './ask-support-drop.js';
import { placedSentencesOfAnswer } from './ask-support.js';

/**
 * Taking out the sentences a support check still found unsupported (D-310). Labelled CI text about an invented lighthouse: never
 * provider output and never product content. The verdicts are written by hand, since the rule is code's and needs no model.
 */
const ANSWER = AuthoredScroll.parse({
  title: 'How a lamp and a prism ring guide sailors',
  dek: 'A ring of glass shapes one beam, and the clockwork turns it so sailors can read the coast.',
  blocks: [
    {
      type: 'paragraph',
      cites: ['e2'],
      text: 'A ring of prisms bends the light into one narrow beam. The beam sweeps across the water.',
    },
    { type: 'heading', text: 'The beam' },
    {
      type: 'paragraph',
      cites: ['e2', 'e3'],
      text: 'Because the beam turns, sailors see it only as a flash. By counting the seconds between flashes, sailors learn which lighthouse they are near. Each tower repeats its own rhythm.',
    },
    { type: 'heading', text: 'The upkeep' },
    {
      type: 'paragraph',
      cites: ['e1', 'e6'],
      text: 'The keeper once wound the clockwork by hand. Today a small motor does that work.',
    },
    {
      type: 'list',
      cites: ['e4'],
      items: ['Fog scatters light in every direction.', 'A sound signal carries through fog.'],
    },
    {
      type: 'callout',
      cites: ['e4'],
      kind: 'limit',
      title: 'Where this stops',
      text: 'This picture ignores radio and satellite navigation. Nothing here explains the cost of building a tower.',
    },
  ],
});
const SENTENCES = placedSentencesOfAnswer(ANSWER);

/** The verdicts for the sentences of `answer`: all supported, except the sentences that start with the words named. */
function verdictsFor(
  answer: AuthoredScroll,
  marks: { readonly flagged?: readonly string[]; readonly noClaim?: readonly string[] } = {},
): SentenceVerdict[] {
  return placedSentencesOfAnswer(answer).map((sentence): SentenceVerdict => {
    if (marks.flagged?.some((start) => sentence.text.startsWith(start)) === true)
      return {
        number: sentence.number,
        verdict: 'unsupported',
        kind: 'not_stated',
        problem: 'A CI note that no passage says this.',
      };
    if (marks.noClaim?.some((start) => sentence.text.startsWith(start)) === true)
      return { number: sentence.number, verdict: 'no_claim' };
    return { number: sentence.number, verdict: 'supported', quote: 'a CI quote of three words' };
  });
}

const dropped = (marks: Parameters<typeof verdictsFor>[1], answer = ANSWER) =>
  dropFlagged(answer, verdictsFor(answer, marks));
const kept = (marks: Parameters<typeof verdictsFor>[1], answer = ANSWER) => {
  const outcome = dropped(marks, answer);
  if (outcome.kind !== 'kept') throw new Error(`CI: expected the answer to be kept, got ${outcome.code}`);
  return outcome;
};
const refusedWith = (marks: Parameters<typeof verdictsFor>[1], answer = ANSWER) => {
  const outcome = dropped(marks, answer);
  return outcome.kind === 'refused' ? outcome.code : 'kept';
};
const textsOf = (answer: AuthoredScroll) => placedSentencesOfAnswer(answer).map((sentence) => sentence.text);

describe('the fixture', () => {
  it('has twelve sentences of reading text, in the places the rules below name', () => {
    expect(SENTENCES.filter((sentence) => sentence.label !== true)).toHaveLength(12);
    expect(SENTENCES.filter((sentence) => sentence.label === true).map((sentence) => sentence.text)).toEqual([
      'How a lamp and a prism ring guide sailors',
      'The beam',
      'The upkeep',
      'Where this stops',
    ]);
  });
});

describe('an answer with nothing flagged', () => {
  it('is served as it is, with nothing dropped', () => {
    expect(kept({})).toEqual({ kind: 'kept', authored: ANSWER, dropped: 0 });
  });
});

describe('a sentence the check still found unsupported', () => {
  it('is taken out of its paragraph, and the other sentences stay in order and word for word', () => {
    const outcome = kept({ flagged: ['By counting the seconds'] });
    expect(outcome.dropped).toBe(1);
    expect(outcome.authored.blocks[2]).toEqual({
      ...ANSWER.blocks[2],
      text: 'Because the beam turns, sailors see it only as a flash. Each tower repeats its own rhythm.',
    });
    // Nothing else changed: the title, the dek and every other block are the writer's own.
    expect(outcome.authored.title).toBe(ANSWER.title);
    expect(outcome.authored.dek).toBe(ANSWER.dek);
    expect(outcome.authored.blocks.filter((_block, index) => index !== 2)).toEqual(
      ANSWER.blocks.filter((_block, index) => index !== 2),
    );
  });

  it('serves exactly the sentences that were not flagged, each with the verdict it was checked with', () => {
    const marks = { flagged: ['By counting the seconds', 'The keeper once', 'A sound signal'] };
    const outcome = kept(marks);
    expect(outcome.dropped).toBe(3);
    const flaggedNumbers = new Set(
      verdictsFor(ANSWER, marks)
        .filter((verdict) => verdict.verdict === 'unsupported')
        .map((verdict) => verdict.number),
    );
    expect(textsOf(outcome.authored)).toEqual(
      SENTENCES.filter((sentence) => !flaggedNumbers.has(sentence.number)).map((sentence) => sentence.text),
    );
  });

  it('removes a block with no sentence left, and a section heading with no block left', () => {
    // All three sentences of the first section's paragraph: the paragraph goes, and so does the heading "The beam" above it.
    const outcome = kept({ flagged: ['Because the beam turns', 'By counting', 'Each tower repeats'] });
    expect(outcome.dropped).toBe(3);
    expect(outcome.authored.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'list',
      'callout',
    ]);
    expect(textsOf(outcome.authored)).not.toContain('The beam');
    expect(textsOf(outcome.authored)).toContain('The upkeep');
  });

  it('keeps a heading whose section still has a block, and removes a heading that was itself flagged', () => {
    const half = kept({ flagged: ['Because the beam turns', 'By counting'] });
    expect(textsOf(half.authored)).toContain('The beam');
    const heading = kept({ flagged: ['The upkeep'] });
    expect(heading.dropped).toBe(1);
    expect(heading.authored.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
      'list',
      'callout',
    ]);
  });

  it('turns a list with one item left into a paragraph of the same passages, and removes a list with none', () => {
    const one = kept({ flagged: ['Fog scatters'] });
    expect(one.authored.blocks[5]).toEqual({
      type: 'paragraph',
      cites: ['e4'],
      text: 'A sound signal carries through fog.',
    });
    const none = kept({ flagged: ['Fog scatters', 'A sound signal'] });
    expect(none.authored.blocks.map((block) => block.type)).not.toContain('list');
  });

  it('takes out a callout title that failed, and a sentence of the callout text, and keeps the limit callout last', () => {
    const title = kept({ flagged: ['Where this stops'] });
    const callout = title.authored.blocks.at(-1);
    expect(callout).toEqual({
      type: 'callout',
      cites: ['e4'],
      kind: 'limit',
      text: 'This picture ignores radio and satellite navigation. Nothing here explains the cost of building a tower.',
    });
    const text = kept({ flagged: ['Nothing here explains'] });
    expect(text.authored.blocks.at(-1)).toMatchObject({
      kind: 'limit',
      title: 'Where this stops',
      text: 'This picture ignores radio and satellite navigation.',
    });
  });

  it('removes a heading with nothing left in its section but never counts the closing limits callout as that section', () => {
    // The upkeep section is the paragraph and the list; the limits callout after them belongs to no section.
    const sectionGone = kept({ flagged: ['The keeper once', 'Today a small motor', 'Fog scatters', 'A sound signal'] });
    expect(sectionGone.authored.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'callout',
    ]);
    expect(textsOf(sectionGone.authored)).not.toContain('The upkeep');
  });

  it('leaves alone a heading that had nothing under it when the writer wrote it', () => {
    const bare = AuthoredScroll.parse({
      ...ANSWER,
      blocks: [...ANSWER.blocks.slice(0, 6), { type: 'heading', text: 'The limits' }, ANSWER.blocks[6]!],
    });
    const outcome = kept({ flagged: ['Because the beam turns'] }, bare);
    expect(textsOf(outcome.authored)).toContain('The limits');
  });
});

describe('what is left must be enough to serve (D-310)', () => {
  it('refuses an answer whose title or dek failed, since neither can be taken out', () => {
    expect(refusedWith({ flagged: ['How a lamp'] })).toBe('title_or_dek_flagged');
    expect(refusedWith({ flagged: ['A ring of glass'] })).toBe('title_or_dek_flagged');
  });

  it('refuses an answer whose direct answer has no supported sentence left', () => {
    expect(refusedWith({ flagged: ['A ring of prisms', 'The beam sweeps'] })).toBe('no_direct_answer');
    // A sentence that states no fact is not an answer: the paragraph keeps one, but it was not supported.
    expect(refusedWith({ flagged: ['A ring of prisms'], noClaim: ['The beam sweeps'] })).toBe('no_direct_answer');
    // One supported sentence is enough.
    expect(kept({ flagged: ['The beam sweeps'] }).dropped).toBe(1);
  });

  it('takes the first paragraph for the direct answer, even when a heading comes first', () => {
    const headed = AuthoredScroll.parse({
      ...ANSWER,
      blocks: [{ type: 'heading', text: 'The short answer' }, ...ANSWER.blocks],
    });
    expect(refusedWith({ flagged: ['A ring of prisms', 'The beam sweeps'] }, headed)).toBe('no_direct_answer');
    expect(kept({ flagged: ['A ring of prisms'] }, headed).dropped).toBe(1);
    const noParagraph = AuthoredScroll.parse({
      ...ANSWER,
      blocks: [ANSWER.blocks[5]!, ANSWER.blocks[6]!],
    });
    expect(refusedWith({ flagged: ['Fog scatters'] }, noParagraph)).toBe('no_direct_answer');
  });

  it('refuses an answer with fewer than five supported sentences of reading text, and serves one with five', () => {
    expect(MIN_SERVED_SENTENCES).toBe(5);
    // Twelve sentences: three flagged, five stating no fact, four supported.
    const four = {
      flagged: ['By counting', 'The keeper once', 'A sound signal'],
      noClaim: ['Each tower', 'Today a small', 'Fog scatters', 'This picture ignores', 'Nothing here'],
    };
    expect(refusedWith(four)).toBe('too_few_supported');
    // The same with one more supported (Nothing here is supported again): five.
    expect(kept({ flagged: four.flagged, noClaim: four.noClaim.slice(0, 4) }).dropped).toBe(3);
  });

  it('does not count a title, a heading or a callout title that is supported among the five', () => {
    // Only four sentences of reading text are supported, beside four supported labels: still too few.
    const marks = {
      flagged: ['By counting', 'The keeper once', 'A sound signal'],
      noClaim: ['Each tower', 'Today a small', 'Fog scatters', 'This picture ignores', 'Nothing here'],
    };
    // Eight verdicts say "supported" in all, the four labels among them, and that is not what the rule counts.
    expect(verdictsFor(ANSWER, marks).filter((verdict) => verdict.verdict === 'supported')).toHaveLength(8);
    expect(refusedWith(marks)).toBe('too_few_supported');
  });

  it('refuses an answer whose limits callout did not survive', () => {
    expect(refusedWith({ flagged: ['This picture ignores', 'Nothing here explains'] })).toBe('no_limit_callout');
    // A limits callout that is not the last block does not count either.
    const buried = AuthoredScroll.parse({
      ...ANSWER,
      blocks: [...ANSWER.blocks.slice(0, 6), ANSWER.blocks[6]!, { type: 'paragraph', cites: ['e1'], text: 'A coda.' }],
    });
    expect(refusedWith({ flagged: ['Fog scatters'] }, buried)).toBe('no_limit_callout');
  });

  it('refuses a verdict list that does not cover every sentence, since nothing is served unchecked', () => {
    expect(dropFlagged(ANSWER, verdictsFor(ANSWER, { flagged: ['By counting'] }).slice(1))).toEqual({
      kind: 'refused',
      code: 'verdicts_incomplete',
    });
  });

  it('refuses when what is left is not a valid answer', () => {
    // A paragraph limit that the rebuilt text cannot break, so make the callout cite nothing: the schema needs a citation.
    const nothingCited = {
      ...ANSWER,
      blocks: ANSWER.blocks.map((block) => ({ ...block, cites: [] })),
    } as AuthoredScroll;
    expect(refusedWith({ flagged: ['By counting'] }, nothingCited)).toBe('rebuilt_invalid');
  });
});
