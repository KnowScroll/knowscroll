import { describe, expect, it } from 'vitest';
import type { Violation } from '../invariants.js';
import { KNOWN_FAILURES, explainedBy, explains, type KnownFailure } from '../known-failures.js';

const violation = (overrides: Partial<Violation> & { detail?: Record<string, unknown> }): Violation => ({
  invariant: 'I1',
  code: 'met_offered_while_unseen_left',
  persona: 'cold-start-explorer',
  message: 'a repeat',
  detail: {},
  ...overrides,
});

/**
 * How known failures absorb violations: only for the invariant, the persona and the reason they state. A defect cannot hide
 * behind an entry that is wider than its stated reason. It needs no database.
 */
describe('known failure rules', () => {
  it('explains an I1 repeat only for the causes of the soft penalty', () => {
    for (const cause of ['soft_penalty', 'exploration_draw', 'format_sticky'])
      expect(explainedBy(violation({ detail: { cause } })), cause).toBeDefined();
    // An unclear cause is not understood, and not absorbed.
    for (const cause of ['other_exclusion', 'unknown'])
      expect(explainedBy(violation({ detail: { cause } })), cause).toBeUndefined();
  });

  it('explains a retrieval repeat only where retrieval could have been capped', () => {
    // Unseen units that never reached the Composer are a retrieval defect: absorbed past the 100-candidate cap, a new defect below it.
    expect(explainedBy(violation({ detail: { cause: 'retrieval', formatAssets: 172 } }))?.id).toBe(
      'I1/retrieval-never-reaches-unseen-units',
    );
    expect(explainedBy(violation({ detail: { cause: 'retrieval', formatAssets: 59 } }))).toBeUndefined();
    expect(explainedBy(violation({ detail: { cause: 'retrieval' } }))).toBeUndefined();
  });

  it('does not explain a violation of another invariant, code or persona than the entry names', () => {
    const entry: KnownFailure = {
      id: 'test/entry',
      invariant: 'I2',
      slice: '0.0',
      personas: ['a-reader'],
      reason: 'for a test',
      matches: (candidate) => candidate.code === 'system_not_formed',
    };
    const base = { invariant: 'I2' as const, code: 'system_not_formed', detail: {} };
    expect(explains(entry, violation({ ...base, persona: 'a-reader' }))).toBe(true);
    expect(explains(entry, violation({ ...base, persona: 'another-reader' }))).toBe(false);
    expect(explains(entry, violation({ ...base, persona: 'a-reader', invariant: 'I3' }))).toBe(false);
    expect(explains(entry, violation({ ...base, persona: 'a-reader', code: 'planet_not_formed' }))).toBe(false);
  });

  it('explains a Planner failure only when the worker threw the planned-demand unique index error', () => {
    const planner = (messages: string[], code = 'job_handler_failed') =>
      violation({ invariant: 'I3', code, persona: 'any-reader', detail: { queue: 'planner.run', messages } });
    const constraint = 'duplicate key value violates unique constraint "supply_requests_planner_open_work"';
    expect(explainedBy(planner([constraint]))?.id).toBe('I3/planned-demand-duplicates-an-open-request');
    expect(explainedBy(planner([constraint, 'PLANNER_CLAIM_WAKE_EARLY']))).toBeDefined();
    // Another reason for a Planner failure, or one mixed with another error, is not this defect.
    expect(explainedBy(planner(['DISCOVERY_QUERY_INVALID']))).toBeUndefined();
    expect(explainedBy(planner([constraint, 'something else']))).toBeUndefined();
    expect(explainedBy(planner([]))).toBeUndefined();
  });

  it('keeps every entry narrow: a world-level job failure is never explained', () => {
    for (const code of ['job_failed', 'job_dead_lettered', 'job_not_completed', 'job_handler_failed'])
      expect(explainedBy(violation({ invariant: 'I3', code, persona: 'world' })), code).toBeUndefined();
    expect(KNOWN_FAILURES.every((entry) => entry.reason.length > 40)).toBe(true);
  });
});
