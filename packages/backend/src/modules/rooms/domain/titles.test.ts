import { describe, expect, it } from 'vitest';
import { NEUTRAL_TOPIC_TITLE, TITLE_MAX_CHARS, shownTitle, titleFrom } from './titles.js';

describe('titleFrom', () => {
  it('collapses whitespace and drops control characters', () => {
    expect(titleFrom('  What   one\tanswer\ncosts \u0007 to serve ', 'Shared')).toBe('What one answer costs to serve');
  });

  it('cuts a long title on a character boundary with an ellipsis', () => {
    const title = titleFrom('😀'.repeat(TITLE_MAX_CHARS + 20), 'Shared');
    expect([...title]).toHaveLength(TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps a title that fits as it is, and falls back when nothing is left', () => {
    expect(titleFrom('x'.repeat(TITLE_MAX_CHARS), 'Shared')).toBe('x'.repeat(TITLE_MAX_CHARS));
    expect(titleFrom(' \u0001 ', 'Shared')).toBe('Shared');
  });
});

describe('shownTitle', () => {
  const derived = { title: 'So the Moon alone explains the tides', titleDerived: true };
  const typed = { title: 'Tides, in my words', titleDerived: false };

  it('shows a title made from a message only while the message is shown and its author is not blocked', () => {
    expect(shownTitle(derived, { shown: true, authorBlocked: false })).toBe(derived.title);
    expect(shownTitle(derived, { shown: false, authorBlocked: false })).toBe(NEUTRAL_TOPIC_TITLE);
    expect(shownTitle(derived, { shown: true, authorBlocked: true })).toBe(NEUTRAL_TOPIC_TITLE);
  });

  it('shows no words when the origin cannot be found', () => {
    expect(shownTitle(derived, undefined)).toBe(NEUTRAL_TOPIC_TITLE);
  });

  it('always shows a title the starter typed', () => {
    expect(shownTitle(typed, undefined)).toBe(typed.title);
    expect(shownTitle(typed, { shown: false, authorBlocked: true })).toBe(typed.title);
  });
});
