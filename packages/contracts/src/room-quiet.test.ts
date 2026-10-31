import { describe, expect, it } from 'vitest';
import {
  LeaveQuestionSchema,
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
  QUESTION_REPLIES_MAX,
  QuestionLeftAcceptanceSchema,
  ReadReplayRoundSchema,
  ReplayRoundSchema,
  RoomQuestionsSchema,
  RoomReplaySchema,
  SetQuestionNoticeSchema,
} from './room-quiet.js';
import { RoomViewSchema, roomsContract } from './rooms.js';

const ID = (n: number) => `0199a100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number) => ({
  kind: 'person' as const,
  personId: ID(n),
  displayName: `Person ${String(n)}`,
  handle: `person${String(n)}`,
});
const scoped = { version: 'rooms.v1', readId: ID(90), scope: { accountId: ID(91), privacyEpoch: 1 } };

describe('the replay a member reads (D-241)', () => {
  const question = (round: number) => ({ round, prompt: `Question ${String(round)}?`, options: ['A one', 'A two'] });
  const ready = {
    ...scoped,
    status: 'ready',
    host: { name: 'Pixel', label: 'AI · Quizmaster' },
    replay: {
      launchId: ID(1),
      day: '2026-10-31',
      played: 3,
      questions: [1, 2, 3, 4, 5].map(question),
      answerSeconds: 8,
    },
  };

  it('draws five questions, the day, how many played and the host labelled as AI', () => {
    expect(RoomReplaySchema.safeParse(ready).success).toBe(true);
    expect(RoomReplaySchema.safeParse({ ...ready, replay: undefined }).success).toBe(true);
  });

  it('has no place for a key, a pick or a person in the questions: the right option comes with an answer', () => {
    for (const extra of [{ answer: 1 }, { correct: 1 }, { explain: 'why' }, { choice: 0 }, { by: person(1) }])
      expect(
        RoomReplaySchema.safeParse({
          ...ready,
          replay: { ...ready.replay, questions: [{ ...question(1), ...extra }, ...[2, 3, 4, 5].map(question)] },
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
  });

  it('needs exactly five questions, at least one player and the host with its AI label', () => {
    expect(
      RoomReplaySchema.safeParse({ ...ready, replay: { ...ready.replay, questions: [1, 2, 3, 4].map(question) } })
        .success,
    ).toBe(false);
    expect(RoomReplaySchema.safeParse({ ...ready, replay: { ...ready.replay, played: 0 } }).success).toBe(false);
    expect(RoomReplaySchema.safeParse({ ...ready, host: { name: 'Pixel', label: 'Quizmaster' } }).success).toBe(false);
  });
});

describe('one question of the replay (D-241)', () => {
  const round = {
    ...scoped,
    status: 'ready',
    launchId: ID(1),
    round: 2,
    correct: 1,
    explain: 'Betelgeuse is a red supergiant.',
    locked: 3,
    right: 2,
    calledIt: [{ person: person(2), you: false }],
    quicker: 1,
  };

  it('says how many answered and got it right, who got it right and how many were quicker', () => {
    expect(ReplayRoundSchema.safeParse(round).success).toBe(true);
  });

  it('never says more got it right than answered, nor more faces than got it right, nor more quicker than right', () => {
    expect(ReplayRoundSchema.safeParse({ ...round, right: 4 }).success).toBe(false);
    expect(ReplayRoundSchema.safeParse({ ...round, right: 0 }).success).toBe(false);
    expect(ReplayRoundSchema.safeParse({ ...round, quicker: 3 }).success).toBe(false);
  });

  it('has no field for who was wrong, what anyone picked or how long anyone took', () => {
    for (const extra of [{ wrong: [person(3)] }, { picks: [0, 1] }, { times: [2000] }, { elapsedMs: 3000 }])
      expect(ReplayRoundSchema.safeParse({ ...round, ...extra }).success, JSON.stringify(extra)).toBe(false);
  });

  it('is read with a choice and a time, or with neither when the time ran out, and a time needs a choice', () => {
    const read = { version: 'rooms.v1', readId: ID(9), roomId: ID(2), launchId: ID(1), round: 3 };
    expect(ReadReplayRoundSchema.safeParse(read).success).toBe(true);
    expect(ReadReplayRoundSchema.safeParse({ ...read, choice: 1, elapsedMs: 2_500 }).success).toBe(true);
    expect(ReadReplayRoundSchema.safeParse({ ...read, elapsedMs: 2_500 }).success).toBe(false);
    expect(ReadReplayRoundSchema.safeParse({ ...read, choice: 1, elapsedMs: 8_001 }).success).toBe(false);
    expect(ReadReplayRoundSchema.safeParse({ ...read, round: 6 }).success).toBe(false);
  });
});

describe('a question left for people (D-242)', () => {
  const leave = {
    version: 'rooms.v1',
    commandId: ID(7),
    roomId: ID(2),
    text: 'How do astronomers know how far away a star is?',
    askNow: true,
    notify: true,
  };

  it('takes words, whether to ask a resident now and whether to be told', () => {
    expect(LeaveQuestionSchema.safeParse(leave).success).toBe(true);
    expect(LeaveQuestionSchema.safeParse({ ...leave, askNow: false, notify: false }).success).toBe(true);
  });

  it('wants a question with some words in it, and not a page', () => {
    expect(LeaveQuestionSchema.safeParse({ ...leave, text: 'x'.repeat(QUESTION_MIN_LENGTH - 1) }).success).toBe(false);
    expect(LeaveQuestionSchema.safeParse({ ...leave, text: ' '.repeat(40) }).success).toBe(false);
    expect(LeaveQuestionSchema.safeParse({ ...leave, text: 'x'.repeat(QUESTION_MAX_LENGTH) }).success).toBe(true);
    expect(LeaveQuestionSchema.safeParse({ ...leave, text: 'x'.repeat(QUESTION_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('says whether a resident is writing, was full, or could not read the words', () => {
    const accepted = {
      version: 'rooms.v1',
      scope: scoped.scope,
      commandId: ID(7),
      recordedAt: '2026-11-01T10:00:00.000Z',
      replayed: false,
      outcome: 'accepted',
      operation: 'question.leave',
      roomId: ID(2),
      discussionId: ID(3),
    };
    for (const asked of ['queued', 'resting', 'kept_out', 'not_asked'])
      expect(QuestionLeftAcceptanceSchema.safeParse({ ...accepted, asked }).success, asked).toBe(true);
    expect(QuestionLeftAcceptanceSchema.safeParse({ ...accepted, asked: 'answered' }).success).toBe(false);
  });

  it('is told by the notice switch, which changes something or is refused', () => {
    const notice = { version: 'rooms.v1', commandId: ID(8), roomId: ID(2), discussionId: ID(3) };
    expect(SetQuestionNoticeSchema.safeParse({ ...notice, notify: false }).success).toBe(true);
    expect(SetQuestionNoticeSchema.safeParse({ ...notice, noticed: true }).success).toBe(true);
    expect(SetQuestionNoticeSchema.safeParse(notice).success).toBe(false);
    expect(SetQuestionNoticeSchema.safeParse({ ...notice, noticed: false }).success).toBe(false);
  });

  it('shows a room how many questions wait and the asker which of theirs a person answered, never an AI', () => {
    const reply = {
      discussionId: ID(3),
      title: 'How far is a star?',
      by: person(4),
      askedAt: '2026-11-01T21:14:00.000Z',
      at: '2026-11-03T19:02:00.000Z',
    };
    expect(RoomQuestionsSchema.safeParse({ waiting: 3, replies: [reply] }).success).toBe(true);
    expect(RoomQuestionsSchema.safeParse({ waiting: 0, replies: [] }).success).toBe(true);
    const ai = { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' };
    expect(RoomQuestionsSchema.safeParse({ waiting: 1, replies: [{ ...reply, by: ai }] }).success).toBe(false);
    expect(
      RoomQuestionsSchema.safeParse({
        waiting: 1,
        replies: Array.from({ length: QUESTION_REPLIES_MAX + 1 }, () => reply),
      }).success,
    ).toBe(false);
  });
});

describe('where the quiet room speaks', () => {
  it('serves the replay and the question commands from the rooms controller', () => {
    for (const route of ['replay', 'replayRound', 'leaveQuestion', 'questionNotice'] as const)
      expect(roomsContract[route], route).toBeDefined();
  });

  it('adds a replay and questions only to a member’s own view of a room, never to a preview', () => {
    const preview = RoomViewSchema.options.find((option) => option.shape.status.value === 'preview')!;
    const member = RoomViewSchema.options.find((option) => option.shape.status.value === 'member')!;
    expect('replay' in preview.shape || 'questions' in preview.shape).toBe(false);
    expect('replay' in member.shape && 'questions' in member.shape).toBe(true);
  });
});
