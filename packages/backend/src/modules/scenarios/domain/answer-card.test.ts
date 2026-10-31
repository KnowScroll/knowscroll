import { describe, expect, it } from 'vitest';
import {
  ANSWER_HINTS,
  answerRefusals,
  readableAnswerOf,
  storedAnswerOf,
  type AnswerDraft,
  type CardPassage,
} from './answer-card.js';

/** Passages as a thread root's Scroll cites them: invented for the test, never product content. */
const passages: readonly CardPassage[] = [
  {
    handle: 'e1',
    claimId: 'claim-aaa',
    text: 'Tidal range on open coasts is typically about 2 m, and the Moon pulls hardest when it is near.',
  },
  {
    handle: 'e2',
    claimId: 'claim-bbb',
    text: 'The strength of tidal pull grows with the mass of the body that raises the tide.',
  },
  {
    handle: 'e3',
    claimId: 'claim-ccc',
    text: 'A neap tide follows when the Sun and Moon pull at right angles to each other.',
  },
];
const premises = ['The Moon is twice as wide', 'Its distance stays the same', 'What if the Moon were twice its size?'];

const good: AnswerDraft = {
  assumption: 'We read “twice the size” as twice as wide, so about eight times the mass.',
  claims: [
    { text: 'Tides would likely be much stronger, because a heavier moon pulls harder on the sea.', cites: ['e2'] },
    { text: 'A coast with a range of 2 m today could see a far larger swing.', cites: ['e1'] },
  ],
  numbers: [{ label: 'Typical range today', value: 'about 2 m', cites: ['e1'] }],
};

const codes = (draft: AnswerDraft, offered = passages, premiseTexts = premises) =>
  answerRefusals(draft, offered, premiseTexts).map((refusal) => refusal.code);

describe('the card’s checks', () => {
  it('lets a card through that cites real passages, states only sourced figures and reads as reasoning', () => {
    expect(codes(good)).toEqual([]);
  });

  it('refuses a citation of a passage that was not offered', () => {
    const draft = { ...good, claims: [{ ...good.claims[0]!, cites: ['e9'] }, good.claims[1]!] };
    expect(codes(draft)).toEqual(['unknown_citation']);
    const figure = { ...good, numbers: [{ ...good.numbers[0]!, cites: ['e7'] }] };
    expect(codes(figure)).toEqual(['unknown_citation']);
  });

  it('refuses a digit in a claim that its cited passages do not state', () => {
    const draft = {
      ...good,
      claims: [{ text: 'Tides would likely be 8 times stronger, because a heavier moon pulls harder.', cites: ['e2'] }],
    };
    expect(answerRefusals(draft, passages, premises)).toEqual([
      { code: 'claim_number_unstated', path: ['claims', 0, 'text'] },
    ]);
  });

  it('allows the figure a cited passage states, and the figure the branch’s own premise states', () => {
    const sourced = { ...good, claims: [{ text: 'A coast at 2 m today would likely see more.', cites: ['e1'] }] };
    expect(codes(sourced)).toEqual([]);
    const ownPremise = ['The Moon is 2 times as wide as it is'];
    const draft = { ...good, claims: [{ text: 'A moon 2 times as wide would likely pull harder.', cites: ['e2'] }] };
    expect(codes(draft, passages, ownPremise)).toEqual([]);
    expect(codes(draft, passages, premises)).toEqual(['claim_number_unstated']);
  });

  it('judges a figure against the passages of its own claim, not those of another', () => {
    const draft = { ...good, claims: [{ text: 'A coast at 2 m today would likely see more.', cites: ['e2'] }] };
    expect(codes(draft)).toEqual(['claim_number_unstated']);
  });

  it('refuses an assumption line with a number the branch does not state, and allows one it does', () => {
    expect(codes({ ...good, assumption: 'We read “twice the size” as twice as wide: about 8× the mass.' })).toEqual([
      'assumption_number_unfounded',
    ]);
    expect(
      codes({ ...good, assumption: 'We read “twice the size” as 2 times as wide, not twice the weight.' }, passages, [
        'The Moon is 2 times as wide',
      ]),
    ).toEqual([]);
  });

  it('keeps 4,096 and 4096 the same figure', () => {
    const offered = [
      { handle: 'e1', claimId: 'c', text: 'The tank holds 4,096 litres of water at most.' },
      passages[1]!,
    ];
    const draft = {
      ...good,
      claims: [{ text: 'A tank of 4096 litres would likely drain slowly.', cites: ['e1'] }],
      numbers: [],
    };
    expect(codes(draft, offered)).toEqual([]);
  });

  it('refuses a figure that is not a number, and one no cited passage states', () => {
    expect(codes({ ...good, numbers: [{ label: 'Typical range', value: 'a lot', cites: ['e1'] }] })).toEqual([
      'figure_not_a_number',
    ]);
    expect(codes({ ...good, numbers: [{ label: 'Typical range', value: 'about 3 m', cites: ['e1'] }] })).toEqual([
      'figure_unstated',
    ]);
  });

  it('refuses a claim that copies nine words of a passage', () => {
    const copied = {
      ...good,
      claims: [
        {
          text: 'The strength of tidal pull grows with the mass of the body that raises the tide, so it would likely rise.',
          cites: ['e2'],
        },
      ],
    };
    expect(codes(copied)).toEqual(['copied_passage']);
  });

  it('refuses an answer that states no consequence as reasoning', () => {
    const flat = {
      ...good,
      claims: [{ text: 'Tides are far stronger because a heavier moon pulls harder on the sea.', cites: ['e2'] }],
    };
    expect(codes(flat)).toEqual(['not_marked_as_reasoning']);
  });

  it('refuses two claims that say the same thing', () => {
    const twice = { ...good, claims: [good.claims[0]!, { ...good.claims[0]!, cites: ['e3'] }] };
    expect(codes(twice)).toEqual(['claims_repeat']);
  });

  it('has a fixed hint for every refusal, none of which carries anything the model wrote', () => {
    for (const hint of Object.values(ANSWER_HINTS)) {
      expect(hint.length).toBeGreaterThan(20);
      expect(hint.length).toBeLessThanOrEqual(256);
    }
    expect(Object.keys(ANSWER_HINTS).toSorted()).toEqual(
      [
        'assumption_number_unfounded',
        'claim_number_unstated',
        'claims_repeat',
        'copied_passage',
        'figure_not_a_number',
        'figure_unstated',
        'not_marked_as_reasoning',
        'unknown_citation',
      ].toSorted(),
    );
  });
});

describe('what is stored and what the thread reads', () => {
  it('stores the claims’ own IDs for each citation, once each', () => {
    const stored = storedAnswerOf(
      { ...good, claims: [{ ...good.claims[0]!, cites: ['e2', 'e2'] }, good.claims[1]!] },
      passages,
    );
    expect(stored.claims[0]!.claimIds).toEqual(['claim-bbb']);
    expect(stored.numbers[0]!.claimIds).toEqual(['claim-aaa']);
  });

  it('reads as the assumption, the claims in order as one answer, and the figures: no citation', () => {
    const readable = readableAnswerOf(storedAnswerOf(good, passages));
    expect(readable).toEqual({
      assumption: good.assumption,
      answer: `${good.claims[0]!.text} ${good.claims[1]!.text}`,
      numbers: [{ label: 'Typical range today', value: 'about 2 m' }],
    });
    expect(JSON.stringify(readable)).not.toMatch(/claim-|\be[1-9]\b|cites|claimIds/u);
  });
});
