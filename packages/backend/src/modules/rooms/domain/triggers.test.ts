import { describe, expect, it } from 'vitest';
import { looksLikeQuestion, looksOverstated, triggerOfPersonMessage } from './triggers.js';

describe('looksLikeQuestion', () => {
  it('accepts a question mark at the end and an opening interrogative of enough words', () => {
    expect(looksLikeQuestion('Why is the sky blue?')).toBe(true);
    expect(looksLikeQuestion('How do black holes actually lose mass over time')).toBe(true);
  });

  it('refuses a greeting, a short fragment, a statement and a link', () => {
    expect(looksLikeQuestion('Hi all')).toBe(false);
    expect(looksLikeQuestion('Why?')).toBe(false);
    expect(looksLikeQuestion('The sky is blue because of scattering.')).toBe(false);
    expect(looksLikeQuestion('https://example.invalid/what-is-the-sky?')).toBe(false);
  });
});

describe('looksOverstated', () => {
  it('accepts a claim stated as settled', () => {
    expect(looksOverstated("so we've proven it, the Moon causes the tides alone")).toBe(true);
    expect(looksOverstated('Everyone knows that heavier things fall faster.')).toBe(true);
    expect(looksOverstated('That is 100% how seasons work, obviously.')).toBe(true);
  });

  it('leaves a hedged statement, a question and a short remark alone', () => {
    expect(looksOverstated('I think the tilt matters more than the distance')).toBe(false);
    expect(looksOverstated('Is it always the tilt?')).toBe(false);
    expect(looksOverstated('always true')).toBe(false);
  });
});

describe('triggerOfPersonMessage', () => {
  it('sends a question to the Explainer first and a strong claim to the Skeptic, and nothing else', () => {
    expect(triggerOfPersonMessage('Why do we have seasons?')).toBe('unanswered_question');
    expect(triggerOfPersonMessage("so we've proven it, the tilt is the whole story")).toBe('overstated_claim');
    expect(triggerOfPersonMessage('Is the tilt always the whole story?')).toBe('unanswered_question');
    expect(triggerOfPersonMessage('thanks, that helps')).toBeUndefined();
  });
});
