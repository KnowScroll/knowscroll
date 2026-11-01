import { describe, expect, it } from 'vitest';
import {
  QUICK_ANSWER_RETENTION_HOURS,
  expiryOf,
  handleOf,
  isFromStop,
  quickAnswerRefusals,
  utcDayStart,
  type CitablePassage,
  type QuickAnswerAsk,
  type QuickAnswerDraft,
} from './quick-answer.js';

const passages: readonly CitablePassage[] = [
  { handle: 'e1', stopId: 'a', text: 'Earth’s axis leans 23.4 degrees and keeps pointing the same way all year.' },
  { handle: 'e2', stopId: 'b', text: 'When Delhi’s half leans toward the Sun, sunlight arrives steeper.' },
];
const ask = { passage: 'keeps pointing the same way', question: undefined } as const;
const good: QuickAnswerDraft = {
  question: 'Why does the axis keep its direction?',
  answer: 'The Scroll says the axis leans and keeps pointing the same way through the year.',
  covered: true,
  cites: ['e1'],
};
const codes = (draft: QuickAnswerDraft, from: QuickAnswerAsk = ask) =>
  quickAnswerRefusals(draft, passages, from).map((refusal) => refusal.code);

describe('the rules a Quick answer must satisfy before it is shown', () => {
  it('accepts an answer that rests on a passage it cites', () => {
    expect(codes(good)).toEqual([]);
  });

  it('refuses a citation the writer was not offered, so a later stop can never be cited', () => {
    expect(codes({ ...good, cites: ['e3'] })).toEqual(['unknown_citation']);
    expect(codes({ ...good, cites: ['e1', 'e9'] })).toContain('unknown_citation');
  });

  it('refuses a covered answer with nothing cited, and a citation on an answer that says it is not covered', () => {
    expect(codes({ ...good, cites: [] })).toEqual(['covered_without_citation']);
    expect(codes({ ...good, covered: false })).toEqual(['citation_without_cover']);
    expect(codes({ ...good, covered: false, cites: [], answer: 'What you have read so far does not say.' })).toEqual(
      [],
    );
  });

  it('allows a figure only where a cited passage, the selected words or the typed question state it', () => {
    expect(codes({ ...good, answer: 'It leans 23.4 degrees.' })).toEqual([]);
    expect(codes({ ...good, answer: 'It leans 26 degrees.' })).toEqual(['figure_unstated']);
    // A figure of a passage that is not cited does not count.
    expect(codes({ ...good, answer: 'It leans 23.4 degrees.', cites: ['e2'] })).toEqual(['figure_unstated']);
    expect(codes({ ...good, answer: 'It repeats every 26,000 years.' })).toEqual(['figure_unstated']);
    expect(
      codes(
        { ...good, answer: 'It repeats every 26,000 years.' },
        { passage: ask.passage, question: 'Does 26000 matter?' },
      ),
    ).toEqual([]);
    expect(codes({ ...good, question: 'Is it 90 degrees?' })).toEqual(['figure_unstated']);
  });

  it('refuses anything but plain sentences', () => {
    for (const answer of [
      '**Bold** claim.',
      'A list:\n- one',
      'See https://example.com now.',
      'Go to www.example.com.',
      'A <b>tag</b> here.',
      'Line one.\nLine two.',
    ])
      expect(codes({ ...good, answer })).toContain('not_plain_text');
    expect(codes({ ...good, question: 'Why `this`?' })).toContain('not_plain_text');
  });
});

describe('what the words may be checked against', () => {
  it('names passages e1, e2 and so on in reading order', () => {
    expect([0, 1, 9].map(handleOf)).toEqual(['e1', 'e2', 'e10']);
  });

  it('takes selected words from the stop they were selected in, with other spacing and case', () => {
    expect(isFromStop('keeps  pointing\nthe same way', passages[0]!.text)).toBe(true);
    expect(isFromStop('KEEPS POINTING', passages[0]!.text)).toBe(true);
    expect(isFromStop('sunlight arrives steeper', passages[0]!.text)).toBe(false);
    expect(isFromStop('   ', passages[0]!.text)).toBe(false);
  });
});

describe('the day and how long the words are kept', () => {
  it('counts from the start of the UTC day and keeps a Quick answer for a day', () => {
    const asked = new Date('2026-11-01T17:45:10.000Z');
    expect(utcDayStart(asked).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(expiryOf(asked).toISOString()).toBe('2026-11-02T17:45:10.000Z');
    expect(QUICK_ANSWER_RETENTION_HOURS).toBeGreaterThanOrEqual(24);
  });
});
