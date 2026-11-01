import { describe, expect, it } from 'vitest';
import { ANSWER_MAX_CITES, ANSWER_MAX_SENTENCES } from '../domain/answer-support.js';
import { ANSWER_HINTS, answerSchema, contributionContext, inhabitantRole } from './inhabitant-role.js';
import { residentRole } from './resident-role.js';

const HANDLES = ['e1', 'e2', 'e3', 'e4'];

/** The fixed hint code a schema refusal names, or 'shape' for a refusal that has none, or undefined when it is accepted. */
function refusedWith(inhabitant: 'explainer' | 'skeptic', answer: unknown): string | undefined {
  const parsed = answerSchema(inhabitant, HANDLES).safeParse(answer);
  if (parsed.success) return undefined;
  const params = (parsed.error.issues[0] as { params?: { safeCode?: string } }).params;
  return params?.safeCode ?? 'shape';
}

describe('the answer of a resident that rests on passages (D-298)', () => {
  it('accepts a contribution that cites one to three of the passages offered', () => {
    expect(refusedWith('explainer', { kind: 'explanation', text: 'It drifts.', cites: ['e1'] })).toBeUndefined();
    expect(
      refusedWith('explainer', { kind: 'explanation', text: 'It drifts.', cites: ['e1', 'e2', 'e3'] }),
    ).toBeUndefined();
  });

  it('refuses a contribution that cites nothing, a passage not offered, too many, or one twice, each with its fixed hint', () => {
    expect(refusedWith('explainer', { kind: 'explanation', text: 'It drifts.' })).toBe('cites_missing');
    expect(refusedWith('explainer', { kind: 'explanation', text: 'It drifts.', cites: [] })).toBe('cites_missing');
    expect(refusedWith('explainer', { kind: 'explanation', text: 'It drifts.', cites: ['e9'] })).toBe(
      'unknown_citation',
    );
    expect(refusedWith('explainer', { kind: 'explanation', text: 'It drifts.', cites: ['e1', 'e1'] })).toBe(
      'too_many_cites',
    );
    expect(refusedWith('explainer', { kind: 'explanation', text: 'It drifts.', cites: HANDLES })).toBe(
      'too_many_cites',
    );
    expect(HANDLES.length).toBeGreaterThan(ANSWER_MAX_CITES);
    for (const code of ['cites_missing', 'unknown_citation', 'too_many_cites', 'too_many_sentences'])
      expect(ANSWER_HINTS[code as keyof typeof ANSWER_HINTS]).toMatch(/\S/u);
  });

  it('refuses an answer of more sentences than one request of the check carries', () => {
    const many = Array.from({ length: ANSWER_MAX_SENTENCES + 1 }, () => 'It drifts.').join(' ');
    expect(refusedWith('explainer', { kind: 'explanation', text: many, cites: ['e1'] })).toBe('too_many_sentences');
  });

  it('keeps the rules it had: no link, no claim to be a person, no empty text', () => {
    expect(refusedWith('explainer', { kind: 'explanation', text: 'See https://example.org.', cites: ['e1'] })).toBe(
      'has_link',
    );
    expect(refusedWith('explainer', { kind: 'explanation', text: "I'm a student of this.", cites: ['e1'] })).toBe(
      'claims_to_be_a_person',
    );
    expect(refusedWith('explainer', { kind: 'explanation', text: '  ', cites: ['e1'] })).toBe('empty');
  });

  it('lets a resident say the passages do not cover it, or that it has nothing to add, with no text and no citation', () => {
    for (const kind of ['not_covered', 'nothing_to_add'])
      expect(refusedWith('explainer', { kind, text: '', cites: [] })).toBeUndefined();
    expect(refusedWith('skeptic', { kind: 'not_covered', text: '' })).toBeUndefined();
  });

  it('keeps each resident to its own kinds', () => {
    expect(refusedWith('explainer', { kind: 'counterexample', text: 'It drifts.', cites: ['e1'] })).toBe('shape');
    expect(refusedWith('skeptic', { kind: 'explanation', text: 'It drifts.', cites: ['e1'] })).toBe('shape');
    expect(refusedWith('skeptic', { kind: 'counterexample', text: 'It drifts.', cites: ['e1'] })).toBeUndefined();
  });

  it('tells both kinds of resident to rest on the passages and to say when they do not cover the question', () => {
    for (const role of [inhabitantRole('skeptic', HANDLES), residentRole('skeptic', HANDLES)]) {
      expect(role.instructions).toContain('only facts you may use');
      expect(role.instructions).toContain('"not_covered"');
      expect(role.safeCustomIssues).toBe(ANSWER_HINTS);
    }
    expect(residentRole('explainer', HANDLES).budgetClass).toBe('ambient');
    expect(inhabitantRole('explainer', HANDLES).budgetClass).toBeUndefined();
  });
});

describe('the context a resident reads', () => {
  it('holds each passage under its handle, between the content and the messages', () => {
    const context = contributionContext(
      {
        turnId: 't',
        roomName: 'A room',
        topicMeaning: undefined,
        guidelines: undefined,
        discussionTitle: undefined,
        content: undefined,
        messages: [{ speaker: 'Member 1', text: 'A question?' }],
      },
      [{ handle: 'e1', assetId: 'a', assetRevision: 1, blockId: 's1', text: 'A passage.' }],
    );
    expect(context.items.map((item) => item.ref)).toEqual(['room', 'passage:e1', 'message:1']);
    expect(context.items[1]).toEqual({ ref: 'passage:e1', kind: 'passage', text: '[e1] A passage.' });
  });
});
