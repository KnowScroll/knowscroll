import { describe, expect, it } from 'vitest';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../../infrastructure/config/index.js';
import { castPassQueue, contributeQueue } from '../events.js';
import {
  ANSWER_CLAIM_SECONDS,
  ANSWER_PAID_ATTEMPTS,
  ANSWER_SUPPORT_POLICY,
  AnswerSupportRecordSchema,
  NOT_COVERED_LINE,
} from './answer-support.js';
import { QUEUED_ASK_LAPSES_MS, contributionProblem } from './contribution.js';
import { voiceProblem } from './feed.js';

describe('the line a resident posts when the library cannot support an answer', () => {
  it('is plain, names where to ask, and passes the rules a resident’s words pass', () => {
    expect(NOT_COVERED_LINE).toBe("The library doesn't cover that yet. Ask from here on a Scroll to have one made.");
    expect(contributionProblem(NOT_COVERED_LINE)).toBeUndefined();
    // A resident has no self to speak of: no "I", no "my", no claimed experience.
    expect(voiceProblem(NOT_COVERED_LINE)).toBeUndefined();
  });
});

describe('the request bound of an answer and the claim of its jobs (reasoning README)', () => {
  // The README's rule, written out again: each request may take the quota preflight (10 s), the provider's largest deadline
  // (300 s) and two lock waits (5 s each), one after the other, plus a margin for the reads before and the settle after.
  const claimFor = (requests: number): number => requests * (10 + MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000 + 10) + 30;

  it('counts the writer and its repair, the check and its repair, the one rewrite and its check', () => {
    expect(ANSWER_PAID_ATTEMPTS).toBe(2 + 2 + 1 + 1);
    expect(ANSWER_PAID_ATTEMPTS).toBe(6);
  });

  it('gives a delivery the time for every attempt, 1,950 s', () => {
    expect(ANSWER_CLAIM_SECONDS).toBe(claimFor(ANSWER_PAID_ATTEMPTS));
    expect(ANSWER_CLAIM_SECONDS).toBe(1950);
  });

  it('is the claim of both jobs that make a resident’s answer, so neither is expired while the provider is still working', () => {
    expect(contributeQueue.policy.expireInSeconds).toBeGreaterThanOrEqual(claimFor(ANSWER_PAID_ATTEMPTS));
    expect(castPassQueue.policy.expireInSeconds).toBeGreaterThanOrEqual(claimFor(ANSWER_PAID_ATTEMPTS));
    // And no more than the bound: one more attempt would not fit, so the bound cannot grow without the claim growing.
    expect(claimFor(ANSWER_PAID_ATTEMPTS + 1)).toBeGreaterThan(contributeQueue.policy.expireInSeconds);
    expect(claimFor(ANSWER_PAID_ATTEMPTS + 1)).toBeGreaterThan(castPassQueue.policy.expireInSeconds);
  });
});

describe('how long an ask holds its discussion', () => {
  it('outlasts the claim of the job that answers it, so a second ask cannot start while the first may still be running', () => {
    expect(QUEUED_ASK_LAPSES_MS).toBeGreaterThan(ANSWER_CLAIM_SECONDS * 1000);
    expect(QUEUED_ASK_LAPSES_MS).toBeGreaterThan(contributeQueue.policy.expireInSeconds * 1000);
    expect(QUEUED_ASK_LAPSES_MS).toBe(37.5 * 60 * 1000);
  });
});

describe('how an answer came out, as kept on its turn', () => {
  const record = {
    policy: ANSWER_SUPPORT_POLICY,
    result: 'cleared_after_rewrite',
    cited: [{ assetId: '00000000-0000-4000-8000-0000000000a1', assetRevision: 2, blockId: 's4' }],
    flagged: [1, 0],
  };

  it('is read back when it has this shape', () => {
    expect(AnswerSupportRecordSchema.parse(record)).toEqual(record);
  });

  it('is not a record when it names a word, another outcome or too many passages', () => {
    for (const bad of [
      { ...record, text: 'a word' },
      { ...record, result: 'posted' },
      { ...record, policy: 'other' },
      { ...record, cited: Array.from({ length: 4 }, () => record.cited[0]) },
      { ...record, flagged: [1, 2, 3] },
      null,
      'cleared',
    ])
      expect(AnswerSupportRecordSchema.safeParse(bad).success).toBe(false);
  });
});
