import { describe, expect, it } from 'vitest';
import { settledOutcomeViolations, thrownBy, type Violation } from '../invariants.js';
import type { FormationPoint } from '../model.js';
import type { PersonaResult } from '../run.js';
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
  it('absorbs no I1 repeat: composer policy v2 fixed the soft penalty, so a repeat is a new defect whatever its cause', () => {
    for (const cause of [
      'soft_penalty',
      'exploration_draw',
      'format_sticky',
      'retrieval',
      'other_exclusion',
      'unknown',
    ])
      expect(explainedBy(violation({ detail: { cause } })), cause).toBeUndefined();
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

  it('reads what a queue threw from every persona, not only from the one whose run was held', () => {
    // A drain is global, so in a side-by-side pair the other person's drain may be the one that ran, and recorded, the throw.
    const result = (errors: Record<string, string[]>) => ({ run: { drains: { errors } } }) as unknown as PersonaResult;
    const results = [
      result({}),
      result({ 'planner.run': ['one', 'two'] }),
      result({ 'planner.run': ['two', 'three'] }),
    ];
    expect(thrownBy(results, 'planner.run')).toEqual(['one', 'two', 'three']);
    expect(thrownBy(results, 'geography.cartograph')).toEqual([]);
  });

  it('explains a Reel-only system failure only when Personal Context holds nothing under the system', () => {
    const notFormed = (referencesUnderSystem: number, supportsUnderSystem: number, onlyWithReels = true) =>
      violation({
        invariant: 'I2',
        code: 'system_not_formed',
        detail: { onlyWithReels, referencesUnderSystem, supportsUnderSystem },
      });
    expect(explainedBy(notFormed(0, 0))?.id).toBe('I2/reel-only-evidence-forms-no-system');
    // Scroll evidence under the system that failed to form is a new defect, as is any reference or support under it.
    expect(explainedBy(notFormed(0, 0, false))).toBeUndefined();
    expect(explainedBy(notFormed(1, 0))).toBeUndefined();
    expect(explainedBy(notFormed(0, 1))).toBeUndefined();
  });

  it('judges what Geography settles against what the person held when the step began', () => {
    const point = (
      encounter: number,
      trustedSupports: number,
      references: number,
      insufficientOutcomes: Record<string, number>,
    ): FormationPoint => ({
      encounter,
      systems: 0,
      planets: 0,
      regions: 0,
      trustedSupports,
      references,
      insufficientOutcomes,
    });
    const codes = (points: FormationPoint[]) => settledOutcomeViolations('a-reader', points).map((entry) => entry.code);
    // Healthy: nothing due, and no support yet while there are no references (also in the step the first one arrives).
    expect(
      codes([point(1, 0, 0, { no_support_yet: 1 }), point(2, 1, 1, { no_support_yet: 2, no_changes: 1 })]),
    ).toEqual([]);
    expect(codes([point(1, 1, 1, { no_changes: 1 }), point(2, 1, 1, { no_changes: 2, disabled: 1 })])).toEqual([]);
    // no_support_yet once references existed, and any outcome that says the supports could not be used.
    expect(codes([point(1, 1, 1, {}), point(2, 1, 1, { no_support_yet: 1 })])).toEqual([
      'no_support_yet_with_references',
    ]);
    for (const outcome of [
      'no_trusted_support',
      'discovery_limit',
      'coverage_limit',
      'context_limit',
      'context_unreadable',
    ])
      expect(codes([point(1, 1, 1, {}), point(2, 1, 1, { [outcome]: 1 })]), outcome).toEqual([
        'insufficient_with_supports',
      ]);
    // The same outcomes are not blamed on someone who held no support when the step began.
    expect(codes([point(1, 0, 0, {}), point(2, 1, 1, { no_trusted_support: 1 })])).toEqual([]);
  });

  it('keeps every entry narrow: a world-level job failure is never explained', () => {
    for (const code of ['job_failed', 'job_dead_lettered', 'job_not_completed', 'job_handler_failed'])
      expect(explainedBy(violation({ invariant: 'I3', code, persona: 'world' })), code).toBeUndefined();
    expect(KNOWN_FAILURES.every((entry) => entry.reason.length > 40)).toBe(true);
  });
});
