import { describe, expect, it } from 'vitest';
import { acceptsNewActivity, acceptsVotes, definitionOf, titleOf } from './activities.js';

describe('definitionOf', () => {
  it('gives a poll its options in the order given, as o1..', () => {
    expect(definitionOf({ kind: 'poll', prompt: 'First?', options: ['A', 'B', 'C'] })).toEqual({
      kind: 'poll',
      prompt: 'First?',
      options: [
        { id: 'o1', text: 'A' },
        { id: 'o2', text: 'B' },
        { id: 'o3', text: 'C' },
      ],
    });
  });

  it('numbers a quiz question and its options and keeps each explanation', () => {
    const definition = definitionOf({
      kind: 'quiz',
      title: 'Batching',
      questions: [
        { prompt: 'One', options: ['Yes', 'No'], explanation: { heading: 'H', text: 'T' } },
        { prompt: 'Two', options: ['Up', 'Down'], explanation: { heading: 'H2', text: 'T2', note: 'N' } },
      ],
    });
    expect(definition.kind === 'quiz' && definition.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(definition.kind === 'quiz' && definition.questions[1]?.options.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(definition.kind === 'quiz' && definition.questions[1]?.explanation.note).toBe('N');
  });

  it('names a poll by its question and a quiz by its title', () => {
    expect(titleOf(definitionOf({ kind: 'poll', prompt: 'Which?', options: ['A', 'B'] }))).toBe('Which?');
    expect(
      titleOf(
        definitionOf({
          kind: 'quiz',
          title: 'Room quiz',
          questions: [{ prompt: 'P', options: ['A', 'B'], explanation: { heading: 'H', text: 'T' } }],
        }),
      ),
    ).toBe('Room quiz');
  });
});

describe('what an activity accepts', () => {
  it('takes votes only while both the room and the poll are open', () => {
    expect(acceptsVotes('open', 'open')).toBe(true);
    expect(acceptsVotes('paused', 'open')).toBe(false);
    expect(acceptsVotes('closed', 'open')).toBe(false);
    expect(acceptsVotes('open', 'closed')).toBe(false);
    expect(acceptsVotes('open', 'removed')).toBe(false);
  });

  it('starts new activity only in an open room', () => {
    expect(acceptsNewActivity('open')).toBe(true);
    expect(acceptsNewActivity('paused')).toBe(false);
    expect(acceptsNewActivity('closed')).toBe(false);
  });
});
