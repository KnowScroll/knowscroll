import { describe, expect, it } from 'vitest';
import type { ProposeRecipesResult } from '../../content/public.js';
import { proposalOf } from './gap-proposal.js';

/** What the content module's answer to a proposal means to the gap loop: keys and codes, never the model's words. */
describe('the gap loop reads a proposal’s outcome as keys and codes', () => {
  const run = 'run-1';
  const proposed: ProposeRecipesResult = {
    kind: 'proposed',
    runId: run,
    repaired: false,
    drafts: 3,
    accepted: [
      { key: 'gen-a', facetId: 'f', title: 'A title the loop never keeps', pool: 8 },
      { key: 'gen-b', facetId: 'f', title: 'Another title', pool: 9 },
    ],
    refused: {},
    requestBound: 2,
  };

  it('takes the stored recipes of a run, however many deliveries stored them, and drops everything else', () => {
    expect(proposalOf(proposed)).toEqual({ kind: 'recipes', runId: run, keys: ['gen-a', 'gen-b'] });
    expect(proposalOf({ kind: 'already_proposed', runId: run, recipes: ['gen-a'] })).toEqual({
      kind: 'recipes',
      runId: run,
      keys: ['gen-a'],
    });
    expect(JSON.stringify(proposalOf(proposed))).not.toContain('title');
  });

  it('calls a closed run that stored nothing a failed attempt, with the reason the content module gave', () => {
    expect(
      proposalOf({ kind: 'closed_failed', runId: run, reason: 'nothing_accepted', retry: 0, nextRetry: 1 }),
    ).toEqual({
      kind: 'failed',
      runId: run,
      code: 'nothing_accepted',
    });
    expect(proposalOf({ kind: 'closed_failed', runId: run, reason: 'failed', retry: 0 })).toMatchObject({
      code: 'model_failed',
    });
    expect(proposalOf({ kind: 'closed_failed', runId: run, reason: 'closed', retry: 0 })).toMatchObject({
      code: 'closed',
    });
  });

  it('passes a refusal that no retry changes, and a spent budget, as they are', () => {
    expect(proposalOf({ kind: 'refused', reason: 'no_candidate_pages' })).toEqual({
      kind: 'refused',
      code: 'no_candidate_pages',
    });
    expect(proposalOf({ kind: 'paused', runId: run, code: 'budget_exhausted' })).toEqual({
      kind: 'paused',
      code: 'budget_exhausted',
    });
  });

  it('never resends an attempt of unknown outcome or a refusal that may have reached the provider', () => {
    expect(
      proposalOf({ kind: 'failed', runId: run, code: 'unknown_outcome', unknown: true, closed: false }),
    ).toMatchObject({
      kind: 'unknown',
    });
    expect(
      proposalOf({ kind: 'failed', runId: run, code: 'policy_refused', unknown: false, closed: false }),
    ).toMatchObject({
      kind: 'unknown',
    });
  });

  it('retries later, with the same identity, a store that was refused after the answer was kept', () => {
    expect(proposalOf({ kind: 'failed', runId: run, code: 'scope_refused', unknown: false, closed: false })).toEqual({
      kind: 'paused',
      code: 'scope_refused',
    });
    expect(
      proposalOf({ kind: 'failed', runId: run, code: 'invalid_output', unknown: false, closed: true }),
    ).toMatchObject({
      kind: 'failed',
      code: 'model_failed',
    });
  });
});
