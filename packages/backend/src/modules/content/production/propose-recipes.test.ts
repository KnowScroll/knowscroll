import { describe, expect, it } from 'vitest';
import type { ProposeOutcome } from '../../../reasoning/public.js';
import { settlementOf } from './propose-recipes.js';

const attemptId = '00000000-0000-4000-8000-000000000001';
const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null };

/** What a proposing run does to its run, after the production job's convention: only a settled attempt ends it. */
describe('what each outcome of the brief role does to its run', () => {
  const outcomes: readonly [string, ProposeOutcome<unknown>, 'completed' | 'failed' | 'open'][] = [
    [
      'a kept answer completes it',
      { kind: 'proposed', output: {}, attemptId, usage, repaired: false, reconciled: false },
      'completed',
    ],
    [
      'an answer invalid after its one repair closes it as failed',
      { kind: 'invalid_output', attemptId, reason: 'schema' },
      'failed',
    ],
    [
      'a provider that conclusively refused closes it as failed',
      { kind: 'failed', attemptId, code: 'HTTP_429' },
      'failed',
    ],
    ['an attempt of unknown outcome keeps it open: nothing resends it', { kind: 'unknown', attemptId }, 'open'],
    [
      'a refusal of the harness keeps it open: the attempt may have been sent',
      { kind: 'refused', reason: 'dispatch_lost', attemptId },
      'open',
    ],
    ['a refusal that names no attempt keeps it open too', { kind: 'refused', reason: 'request_mismatch' }, 'open'],
    ['an attempt written off keeps it open', { kind: 'refused', reason: 'attempt_written_off', attemptId }, 'open'],
    ['a spent budget only pauses it', { kind: 'budget_exhausted', dimension: 'role', limit: 'requests' }, 'open'],
    ['an unavailable quota only pauses it', { kind: 'quota_unavailable', attemptId }, 'open'],
  ];

  it.each(outcomes)('%s', (_name, outcome, expected) => {
    expect(settlementOf(outcome)).toBe(expected);
  });
});
