import { describe, expect, it } from 'vitest';
import type { ProposeOutcome } from '../../../reasoning/public.js';
import {
  ASK_LIBRARY_ROLE_VERSION,
  MAX_LIBRARY_CHOICES,
  askLibraryAnswerSchema,
  askLibraryContext,
  askLibraryRole,
  libraryChoice,
  libraryVerdict,
  type AskLibraryAnswer,
  type LibraryChoice,
} from './ask-library-role.js';

/** Labelled CI Scrolls about an invented lighthouse: never product content. */
const choices: readonly LibraryChoice[] = [
  libraryChoice(
    0,
    { assetId: '11111111-1111-4111-8111-111111111111', assetRevision: 1 },
    'How a lighthouse beam turns',
    ['A prism ring gathers the light into a single beam.', 'The clockwork turns the ring once every few seconds.'],
  ),
  libraryChoice(1, { assetId: '22222222-2222-4222-8222-222222222222', assetRevision: 3 }, 'Fog signals', [
    'Fog scatters light, so a lighthouse also sounds a horn that carries through the fog.',
  ]),
];

describe('the choices a question is read against', () => {
  it('give each Scroll a handle in order, and keep only as much of its text as the checker is shown', () => {
    expect(choices.map((choice) => choice.handle)).toEqual(['s1', 's2']);
    expect(MAX_LIBRARY_CHOICES).toBe(3);
    const long = libraryChoice(2, choices[0]!.ref, 'Long', ['word '.repeat(5000)]);
    expect(long.text.length).toBeLessThanOrEqual(8000);
  });

  it('are shown as data beside the question, one item each', () => {
    const context = askLibraryContext('request-1', 'Why does the beam turn?', choices);
    expect(context.bundleRef).toBe('supply-ask-library:request-1');
    expect(context.items.map((item) => item.kind)).toEqual(['learner_request', 'library_scroll', 'library_scroll']);
    expect(context.items[0]!.text).toBe('Why does the beam turn?');
    expect(JSON.parse(context.items[2]!.text)).toMatchObject({ handle: 's2', title: 'Fog signals' });
  });
});

describe('the checker’s answer is validated by code (D-251)', () => {
  const schema = askLibraryAnswerSchema(choices);
  const codes = (value: unknown) => {
    const result = schema.safeParse(value);
    return result.success
      ? []
      : result.error.issues.map(
          (issue) => (issue as { params?: { safeCode?: string } }).params?.safeCode ?? issue.code,
        );
  };

  it('accepts a Scroll with words copied from its text, or neither', () => {
    expect(schema.safeParse({ scroll: 's1', quote: 'gathers the light into a single beam' }).success).toBe(true);
    expect(schema.safeParse({ scroll: null, quote: null }).success).toBe(true);
  });

  it('refuses a handle that is not a candidate', () => {
    expect(codes({ scroll: 's9', quote: 'gathers the light into a single beam' })).toEqual(['unknown_scroll']);
  });

  it('refuses a Scroll chosen without a quote, and a quote without a Scroll', () => {
    expect(codes({ scroll: 's1', quote: null })).toEqual(['quote_required']);
    expect(codes({ scroll: null, quote: 'gathers the light into a single beam' })).toEqual(['quote_without_scroll']);
  });

  it('refuses a quote that is not in the text of the Scroll chosen, even when another candidate has it', () => {
    expect(codes({ scroll: 's1', quote: 'a horn that carries through the fog' })).toEqual(['quote_not_in_scroll']);
    expect(codes({ scroll: 's1', quote: 'the beam is made of invented words' })).toEqual(['quote_not_in_scroll']);
    expect(codes({ scroll: 's1', quote: 'single beam' })).toEqual(['quote_not_in_scroll']);
  });

  it('has fixed hints for each refusal and the instructions say that choosing none is a good answer', () => {
    const role = askLibraryRole(choices);
    expect(role).toMatchObject({ id: 'supply.ask-library', version: ASK_LIBRARY_ROLE_VERSION });
    expect(Object.keys(role.safeCustomIssues ?? {}).sort()).toEqual([
      'quote_not_in_scroll',
      'quote_required',
      'quote_without_scroll',
      'unknown_scroll',
    ]);
    expect(role.instructions).toContain('Choosing none is a good answer');
  });
});

describe('what the harness outcome means for the question (D-251)', () => {
  const proposed = (output: AskLibraryAnswer): ProposeOutcome<AskLibraryAnswer> => ({
    kind: 'proposed',
    output,
    attemptId: 'a1',
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: null } as never,
    repaired: false,
    reconciled: false,
  });

  it('offers a Scroll only on a proposed answer that names one', () => {
    expect(libraryVerdict(proposed({ scroll: 's2', quote: 'a horn that carries' }), choices)).toEqual({
      kind: 'pick',
      ref: choices[1]!.ref,
      end: 'completed',
    });
    expect(libraryVerdict(proposed({ scroll: null, quote: null }), choices)).toEqual({
      kind: 'none',
      end: 'completed',
    });
  });

  it('offers none when the reply stayed unusable or the provider failed, so the person gets an answer made for them', () => {
    expect(libraryVerdict({ kind: 'invalid_output', attemptId: 'a', reason: 'invalid' }, choices)).toEqual({
      kind: 'none',
      end: 'failed',
    });
    expect(libraryVerdict({ kind: 'failed', attemptId: 'a', code: 'HTTP_500' }, choices)).toEqual({
      kind: 'none',
      end: 'failed',
    });
  });

  it('closes the ask honestly for a spent budget, and never resends an attempt of unknown outcome', () => {
    expect(
      libraryVerdict({ kind: 'budget_exhausted', dimension: 'personal', limit: 'requests' } as never, choices),
    ).toEqual({
      kind: 'unavailable',
      reason: 'budget_unavailable',
      end: 'cancelled',
    });
    // The run stays open: no `end`.
    expect(libraryVerdict({ kind: 'unknown', attemptId: 'a' }, choices)).toEqual({
      kind: 'unavailable',
      reason: 'could_not_prepare',
    });
    expect(libraryVerdict({ kind: 'refused', reason: 'scope_refused' }, choices)).toEqual({
      kind: 'unavailable',
      reason: 'could_not_prepare',
    });
  });

  it('offers nothing when an earlier delivery already closed the check’s run: its verdict is lost, so an order is made', () => {
    expect(libraryVerdict({ kind: 'refused', reason: 'run_closed' }, choices)).toEqual({ kind: 'none' });
  });
});
