import { describe, expect, it } from 'vitest';
import type { ThreadCall } from '@knowscroll/contracts';
import {
  callChipWords,
  callForBar,
  callKey,
  callPartLabel,
  callSummaryWords,
  callUpdateWords,
  optionLetter,
  revealWords,
} from './call-words';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const base = {
  part: 2,
  assetId: id(40),
  assetRevision: 1,
  prompt: 'When are tides biggest?',
  options: ['Full and new moon', 'Half moon', 'Always the same'],
  called: 2,
  of: 4,
};
const person = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' };
type Revealed = Extract<ThreadCall, { stage: 'revealed' }>;
const revealed = (patch: Partial<Revealed> = {}): Revealed => ({
  ...base,
  stage: 'revealed',
  option: 0,
  answer: 0,
  explain: 'Spring tides.',
  right: true,
  picks: [{ person, you: true, option: 0, right: true }],
  rightCount: 1,
  ...patch,
});

describe('the words for a Scroll that was updated since the call began (D-233)', () => {
  it('says the call keeps the question the thread called on, or asks the new one afresh, and nothing when it is current', () => {
    expect(callUpdateWords({ part: 1, updated: 'held' })).toBe(
      'Part 1 has been updated since your thread started calling. The call keeps the question your thread called on, so everyone answers the same one.',
    );
    expect(callUpdateWords({ part: 3, updated: 'restarted' })).toBe(
      'Part 3 has been updated, and the question your thread called on can’t be shown any more. This call asks the new question afresh.',
    );
    expect(callUpdateWords({ part: 2 })).toBeUndefined();
  });
});

describe('the words of a call', () => {
  it('letters the options and names the part', () => {
    expect([0, 1, 2].map(optionLetter)).toEqual(['A', 'B', 'C']);
    expect(callPartLabel({ part: 2 })).toBe('Before Part 2');
  });

  it('counts who called and says what the person waits for, without naming anyone', () => {
    expect(callSummaryWords({ ...base, stage: 'open' })).toBe(
      '2 of 4 have called · answers stay hidden until you call',
    );
    expect(callSummaryWords({ ...base, called: 0, stage: 'open' })).toBe(
      'Nobody has called yet · answers stay hidden until you call',
    );
    expect(callSummaryWords({ ...base, stage: 'locked', option: 1 })).toContain(
      'has finished Part 2, or after two days',
    );
    expect(callSummaryWords({ ...base, stage: 'closed', reason: 'revealed' })).toContain('revealed without you');
    expect(callSummaryWords({ ...base, stage: 'closed', reason: 'started' })).toContain('you started this part');
    expect(callSummaryWords(revealed())).toContain('revealed together');
  });

  it('offers a chip only on a call that can still be acted on or is waiting', () => {
    expect(callChipWords({ ...base, stage: 'open' })).toBe('Call it first · 2 of 4 in');
    expect(callChipWords({ ...base, stage: 'locked', option: 0 })).toBe('Called · waiting for the party');
    expect(callChipWords(revealed())).toBe('Revealed');
    expect(callChipWords({ ...base, stage: 'closed', reason: 'started' })).toBeUndefined();
  });

  it('calls a right pick "Called it!" with a spark, and a wrong one a plot twist with none, never a loss', () => {
    expect(revealWords(revealed())).toEqual({ title: 'Called it!', spark: '+1 spark' });
    expect(revealWords(revealed({ rightCount: 3 }))).toEqual({ title: 'Called it!', spark: '+1 for 3 of you' });
    expect(revealWords(revealed({ right: false, option: 1, twist: 'Smaller neap tides.', rightCount: 3 }))).toEqual({
      title: 'Plot twist!',
      spark: undefined,
    });
  });
});

describe('the call the bar offers', () => {
  const at = (part: number, stage: 'open' | 'locked' | 'closed') =>
    ({
      ...base,
      part,
      assetId: id(40 + part),
      stage,
      ...(stage === 'locked' ? { option: 0 } : {}),
      ...(stage === 'closed' ? { reason: 'started' } : {}),
    }) as ThreadCall;

  it('is the first call the person can still make, then the first they wait on, then an unseen reveal', () => {
    const open = at(3, 'open');
    const locked = at(2, 'locked');
    const reveal = revealed({ part: 1, assetId: id(41) });
    expect(callForBar([reveal, locked, open], new Set())).toBe(open);
    expect(callForBar([reveal, locked], new Set())).toBe(locked);
    expect(callForBar([reveal], new Set())).toBe(reveal);
  });

  it('stays quiet once a reveal was opened here, and for a call that is closed', () => {
    const reveal = revealed({ part: 1, assetId: id(41) });
    expect(callForBar([reveal], new Set([callKey(reveal)]))).toBeUndefined();
    expect(callForBar([at(2, 'closed')], new Set())).toBeUndefined();
    expect(callForBar([], new Set())).toBeUndefined();
  });

  it('remembers a reveal by part and exact revision, so a corrected Scroll asks again', () => {
    const reveal = revealed({ part: 1, assetId: id(41) });
    expect(callKey(reveal)).not.toBe(callKey({ ...reveal, assetRevision: 2 }));
  });
});
