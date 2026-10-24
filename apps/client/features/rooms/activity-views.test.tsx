import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { RoomActivityController, RoomActivityState } from '@knowscroll/client-core';
import type { ActivityView } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { PollCard } from './poll-card';
import { QuizFlow } from './quiz-flow';
import { pollDraft, quizDraft } from './start-activity-sheet';

type Ready = Extract<ActivityView, { status: 'ready' }>;
type Poll = Extract<Ready['activity'], { kind: 'poll' }>;
type Quiz = Extract<Ready['activity'], { kind: 'quiz' }>;

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number, displayName: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${displayName.toLowerCase()}`,
  displayName,
});
const poll = (patch: Partial<Poll> = {}): Poll => ({
  kind: 'poll',
  prompt: 'At 10x requests, what would you try first?',
  options: [
    { optionId: 'o1', text: 'Batching', votes: 0, voters: [] },
    { optionId: 'o2', text: 'More instances', votes: 0, voters: [] },
    { optionId: 'o3', text: 'Shorter answers', votes: 0, voters: [] },
  ],
  canVote: true,
  ...patch,
});
const ready = (activity: Ready['activity'], patch: Partial<Ready> = {}): Ready => ({
  version: 'rooms.v1',
  readId: id(9),
  scope: { accountId: id(2), privacyEpoch: 1 },
  status: 'ready',
  roomId: id(1),
  activityId: id(3),
  state: 'open',
  startedAt: '2026-10-24T08:00:00.000Z',
  canModerate: false,
  activity,
  ...patch,
});
const activityState = (patch: Partial<RoomActivityState> = {}): RoomActivityState => ({
  phase: 'ready',
  view: undefined,
  offline: false,
  working: false,
  notSent: undefined,
  refused: false,
  ...patch,
});
const controller = () =>
  ({ load: jest.fn(), vote: jest.fn(), moderate: jest.fn() }) as unknown as RoomActivityController & {
    vote: jest.Mock;
  };
/** The visible tally is decoration for the row; its words are in the radio's own name. */
const hidden = { includeHiddenElements: true };
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

describe('a poll (R03)', () => {
  it('is optional, offers the options as a radio group and says the vote is visible and changeable', async () => {
    const c = controller();
    const p = poll();
    await wrap(<PollCard view={ready(p)} poll={p} state={activityState()} controller={c} onSkip={jest.fn()} />);
    expect(screen.getByText('Optional')).toBeOnTheScreen();
    expect(screen.getByLabelText(p.prompt)).toBeOnTheScreen();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(
      screen.getByText('Your vote is visible to the room. You can change it until the poll closes.'),
    ).toBeOnTheScreen();
    // Nothing is chosen, so nothing can be sent; and no results show before the person has chosen.
    expect(screen.getByRole('button', { name: 'Vote' })).toBeDisabled();
    expect(screen.queryByText(/votes?$/)).not.toBeOnTheScreen();
  });

  it('chooses an option with a press and votes once', async () => {
    const c = controller();
    const p = poll();
    await wrap(<PollCard view={ready(p)} poll={p} state={activityState()} controller={c} onSkip={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('poll-option-o2'));
    expect(screen.getByRole('radio', { name: 'More instances' })).toBeChecked();
    await fireEvent.press(screen.getByRole('button', { name: 'Vote' }));
    expect(c.vote).toHaveBeenCalledTimes(1);
    expect(c.vote).toHaveBeenCalledWith('o2');
  });

  it('skips with equal weight and without a confirmation', async () => {
    const skip = jest.fn();
    const p = poll();
    await wrap(<PollCard view={ready(p)} poll={p} state={activityState()} controller={controller()} onSkip={skip} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Skip' }));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('shows the tally with who voted once the person has voted, and lets them change it', async () => {
    const c = controller();
    const p = poll({
      yourVote: 'o1',
      options: [
        { optionId: 'o1', text: 'Batching', votes: 2, voters: [person(5, 'Asha'), person(6, 'Ravi')] },
        { optionId: 'o2', text: 'More instances', votes: 1, voters: [person(7, 'Meera')] },
        { optionId: 'o3', text: 'Shorter answers', votes: 0, voters: [] },
      ],
    });
    await wrap(<PollCard view={ready(p)} poll={p} state={activityState()} controller={c} />);
    expect(screen.getByText('2 votes · Asha, Ravi', hidden)).toBeOnTheScreen();
    expect(screen.getByText('1 vote · Meera', hidden)).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Batching, 2 votes, Asha, Ravi' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Change vote' })).toBeDisabled();
    await fireEvent.press(screen.getByTestId('poll-option-o3'));
    await fireEvent.press(screen.getByRole('button', { name: 'Change vote' }));
    expect(c.vote).toHaveBeenCalledWith('o3');
  });

  it('says a closed poll is closed, shows its votes and offers no vote', async () => {
    const p = poll({
      canVote: false,
      options: [
        { optionId: 'o1', text: 'Batching', votes: 3, voters: [person(5, 'Asha')] },
        { optionId: 'o2', text: 'More instances', votes: 0, voters: [] },
      ],
    });
    await wrap(
      <PollCard view={ready(p, { state: 'closed' })} poll={p} state={activityState()} controller={controller()} />,
    );
    expect(screen.getByText('Closed')).toBeOnTheScreen();
    expect(screen.getByText('3 votes · Asha, 2 more', hidden)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Vote' })).not.toBeOnTheScreen();
  });

  it('words an unsent vote as "Not sent yet" and a refused one plainly', async () => {
    const p = poll();
    await wrap(
      <PollCard
        view={ready(p)}
        poll={p}
        state={activityState({ notSent: 'o1', refused: true })}
        controller={controller()}
      />,
    );
    expect(screen.getByText('Not sent yet.')).toBeOnTheScreen();
    expect(screen.getByText('Couldn’t vote.')).toBeOnTheScreen();
  });

  it('is compact in the side panel: no skip, and the reassurance that skipping changes nothing', async () => {
    const p = poll();
    await wrap(<PollCard view={ready(p)} poll={p} state={activityState()} controller={controller()} compact />);
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeOnTheScreen();
    expect(screen.getByText('Skipping it changes nothing for you.')).toBeOnTheScreen();
  });
});

const quiz = (): Quiz => ({
  kind: 'quiz',
  title: 'Room quiz',
  questions: [
    {
      questionId: 'q1',
      prompt: 'Does a large batch size help?',
      options: [
        { optionId: 'o1', text: 'Yes, always' },
        { optionId: 'o2', text: 'Not much' },
      ],
      explanation: { heading: 'Slow trickle', text: 'Batches rarely fill.', note: 'A maximum wait helps.' },
    },
    {
      questionId: 'q2',
      prompt: 'Traffic grows tenfold. What changes?',
      options: [
        { optionId: 'o1', text: 'Batches fill' },
        { optionId: 'o2', text: 'Nothing' },
      ],
      explanation: { heading: 'Ten times the traffic', text: 'Throughput rises.' },
    },
  ],
});

describe('a quiz (R03)', () => {
  it('asks one question at a time and counts them in words, not as a score', async () => {
    await wrap(<QuizFlow quiz={quiz()} canDiscuss onDiscuss={jest.fn()} onDone={jest.fn()} />);
    expect(screen.getByText('Question 1 of 2')).toBeOnTheScreen();
    expect(screen.getByText('Does a large batch size help?')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.queryByText(/score|points|correct|streak|rank/i)).not.toBeOnTheScreen();
  });

  it('lets a person skip any question, and then shows how each one works out with nothing kept', async () => {
    const done = jest.fn();
    const discuss = jest.fn();
    await wrap(<QuizFlow quiz={quiz()} canDiscuss onDiscuss={discuss} onDone={done} />);
    await fireEvent.press(screen.getByTestId('quiz-option-o2'));
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Question 2 of 2')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Skip question' }));
    expect(screen.getByText('Here’s how each one works out.')).toBeOnTheScreen();
    expect(screen.getByText('Nothing is kept as a result.')).toBeOnTheScreen();
    expect(screen.getByText('1 · Slow trickle')).toBeOnTheScreen();
    expect(screen.getByText('A maximum wait helps.')).toBeOnTheScreen();
    // The pick stays on this device and is only echoed back.
    expect(screen.getByText('You picked: Not much')).toBeOnTheScreen();
    expect(screen.queryByText(/You picked: .*(Batches|Nothing)/)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Discuss this' }));
    expect(discuss).toHaveBeenCalledWith('Room quiz');
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not offer to discuss in a room that is not taking messages', async () => {
    await wrap(<QuizFlow quiz={quiz()} canDiscuss={false} onDiscuss={jest.fn()} onDone={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Skip question' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Skip question' }));
    expect(screen.queryByRole('button', { name: 'Discuss this' })).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Done' })).toBeOnTheScreen();
  });
});

describe('what a moderator can start', () => {
  it('needs a question and two to five different options for a poll', () => {
    expect(pollDraft('', ['A', 'B'])).toBeUndefined();
    expect(pollDraft('Which?', ['A', ''])).toBeUndefined();
    expect(pollDraft('Which?', ['A', 'a'])).toBeUndefined();
    expect(pollDraft('  Which?  ', [' A ', 'B', ''])).toEqual({ kind: 'poll', prompt: 'Which?', options: ['A', 'B'] });
  });

  it('needs words, two different options and an explanation for every question of a quiz', () => {
    const question = { prompt: 'P', options: ['A', 'B'], heading: 'H', text: 'T', note: '' };
    expect(quizDraft('', [question])).toBeUndefined();
    expect(quizDraft('Title', [])).toBeUndefined();
    expect(quizDraft('Title', [{ ...question, text: '' }])).toBeUndefined();
    expect(quizDraft('Title', [{ ...question, options: ['A'] }])).toBeUndefined();
    expect(quizDraft('Title', [question])).toEqual({
      kind: 'quiz',
      title: 'Title',
      questions: [{ prompt: 'P', options: ['A', 'B'], explanation: { heading: 'H', text: 'T' } }],
    });
  });
});
