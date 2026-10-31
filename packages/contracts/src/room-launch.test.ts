import { describe, expect, it } from 'vitest';
import {
  AnswerLaunchSchema,
  LAUNCH_HOST,
  LaunchAnsweredAcceptanceSchema,
  LaunchHostSchema,
  LaunchStartedAcceptanceSchema,
  LaunchViewSchema,
  RoomLaunchSchema,
  RoomLaunchStripSchema,
  StartLaunchSchema,
} from './room-launch.js';
import { RoomStationSchema } from './rooms.js';
import { RoomStarActSchema } from './room-sky.js';

const ID = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number) => ({
  kind: 'person' as const,
  personId: ID(n),
  displayName: `Person ${String(n)}`,
  handle: `person${String(n)}`,
});
const question = { launchId: ID(1), round: 2, of: 5, prompt: 'Which is bigger?', options: ['The Sun', 'Betelgeuse'] };
const open = { phase: 'open', ...question, closesInMs: 6_000, youIn: true };
const reveal = {
  phase: 'reveal',
  ...question,
  correct: 1,
  explain: 'Betelgeuse is a red supergiant.',
  locked: 3,
  right: 2,
  calledIt: [{ person: person(1), you: true }],
  yourScore: 1,
  nextInMs: 4_000,
  last: false,
  youIn: true,
};
const entry = (place: number, n: number, over: object = {}) => ({
  place,
  score: 4,
  person: person(n),
  blockedByYou: false,
  you: false,
  ...over,
});
const finished = {
  phase: 'finished',
  launchId: ID(1),
  played: 3,
  podium: [entry(1, 1), entry(2, 2)],
  you: { score: 3, squares: [true, true, false, true, false], place: 2 },
  star: true,
  day: '2026-11-01',
  youIn: true,
};

describe('the Launch a member reads (D-178)', () => {
  it('draws the lobby, an open question, its answer and the podium', () => {
    const lobby = {
      phase: 'lobby',
      launchId: ID(1),
      startsInMs: 12_000,
      players: [{ person: person(1), you: true }],
      youIn: true,
    };
    for (const view of [lobby, open, reveal, finished])
      expect(LaunchViewSchema.safeParse(view).success, view.phase).toBe(true);
  });

  it('has no place in an open question for the key, the reason, a count or who answered', () => {
    for (const extra of [
      { correct: 1 },
      { explain: 'x' },
      { locked: 2 },
      { right: 1 },
      { calledIt: [] },
      { answered: ['a'] },
    ])
      expect(LaunchViewSchema.safeParse({ ...open, ...extra }).success, JSON.stringify(extra)).toBe(false);
  });

  it('refuses an answer that is not one of the options, or more right answers than answers', () => {
    expect(LaunchViewSchema.safeParse({ ...reveal, correct: 2 }).success).toBe(false);
    expect(LaunchViewSchema.safeParse({ ...reveal, right: 4 }).success).toBe(false);
    const crowd = [1, 2, 3].map((n) => ({ person: person(n), you: n === 1 }));
    expect(LaunchViewSchema.safeParse({ ...reveal, calledIt: crowd }).success).toBe(false);
  });

  it('lists at most three on the podium, and a place without a name only when the reader blocked them', () => {
    const four = [entry(1, 1), entry(2, 2), entry(3, 3), entry(3, 4)];
    expect(LaunchViewSchema.safeParse({ ...finished, podium: four }).success).toBe(false);
    const hidden = { place: 1, score: 4, blockedByYou: true, you: false };
    expect(LaunchViewSchema.safeParse({ ...finished, podium: [hidden] }).success).toBe(true);
    expect(LaunchViewSchema.safeParse({ ...finished, podium: [{ ...hidden, person: person(1) }] }).success).toBe(false);
    expect(LaunchViewSchema.safeParse({ ...finished, podium: [{ ...hidden, blockedByYou: false }] }).success).toBe(
      false,
    );
    // Nobody is listed for scoring nothing.
    expect(LaunchViewSchema.safeParse({ ...finished, podium: [entry(1, 1, { score: 0 })] }).success).toBe(false);
  });

  it('shows the caller one square for each question and never what they picked', () => {
    const short = { score: 3, squares: [true, true, false], place: 2 };
    expect(LaunchViewSchema.safeParse({ ...finished, you: short }).success).toBe(false);
    const picks = { score: 3, squares: [true, true, false, true, false], choices: [0, 1, 2, 0, 1] };
    expect(LaunchViewSchema.safeParse({ ...finished, you: picks }).success).toBe(false);
  });

  it('has a person on every face and no AI shape', () => {
    const lobby = { phase: 'lobby', launchId: ID(1), startsInMs: 1, youIn: false };
    const ai = { person: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' }, you: false };
    expect(LaunchViewSchema.safeParse({ ...lobby, players: [ai] }).success).toBe(false);
    expect(LaunchViewSchema.safeParse({ ...reveal, calledIt: [ai] }).success).toBe(false);
  });

  it('names the host with its label, always, and no other host', () => {
    expect(LAUNCH_HOST).toEqual({ name: 'Pixel', label: 'AI · Quizmaster' });
    expect(LaunchHostSchema.safeParse(LAUNCH_HOST).success).toBe(true);
    expect(LaunchHostSchema.safeParse({ name: 'Pixel', label: 'Quizmaster' }).success).toBe(false);
    expect(LaunchHostSchema.safeParse({ name: 'Asha', label: 'AI · Quizmaster' }).success).toBe(false);
  });

  it('says whether a Launch can be started, and why not', () => {
    const base = {
      version: 'rooms.v1',
      readId: ID(2),
      scope: { accountId: ID(3), privacyEpoch: 1 },
      status: 'ready',
      host: LAUNCH_HOST,
    };
    expect(RoomLaunchSchema.safeParse({ ...base, start: { allowed: true } }).success).toBe(true);
    expect(RoomLaunchSchema.safeParse({ ...base, start: { allowed: false, reason: 'few_here' } }).success).toBe(true);
    expect(RoomLaunchSchema.safeParse({ ...base, start: { allowed: false, reason: 'bored' } }).success).toBe(false);
    expect(RoomLaunchSchema.safeParse({ ...base, start: { allowed: false } }).success).toBe(false);
  });
});

describe('the Launch commands (D-220)', () => {
  const command = { version: 'rooms.v1', commandId: ID(4), roomId: ID(5), recordingGeneration: 1 };

  it('has no field for a time, a score or whether an answer is right', () => {
    const body = { ...command, launchId: ID(1), round: 2, choice: 1 };
    expect(AnswerLaunchSchema.safeParse(body).success).toBe(true);
    for (const extra of [{ elapsedMs: 10 }, { correct: true }, { score: 5 }, { at: '2026-11-01T21:00:00Z' }])
      expect(AnswerLaunchSchema.safeParse({ ...body, ...extra }).success, JSON.stringify(extra)).toBe(false);
    expect(AnswerLaunchSchema.safeParse({ ...body, round: 6 }).success).toBe(false);
    expect(AnswerLaunchSchema.safeParse({ ...body, choice: 3 }).success).toBe(false);
  });

  it('carries the recording generation on start, join and answer, as a lock in a Scroll does', () => {
    expect(StartLaunchSchema.safeParse(command).success).toBe(true);
    const { recordingGeneration: _omitted, ...without } = command;
    expect(StartLaunchSchema.safeParse(without).success).toBe(false);
  });

  it('says not_saved, and nothing else, when recording is paused', () => {
    const notSaved = {
      version: 'rooms.v1',
      scope: { accountId: ID(3), privacyEpoch: 1 },
      commandId: ID(4),
      outcome: 'not_saved',
      operation: 'launch.answer',
      roomId: ID(5),
      reason: 'recording_paused',
    };
    expect(LaunchAnsweredAcceptanceSchema.safeParse(notSaved).success).toBe(true);
    expect(LaunchAnsweredAcceptanceSchema.safeParse({ ...notSaved, correct: true }).success).toBe(false);
    expect(LaunchStartedAcceptanceSchema.safeParse(notSaved).success).toBe(false);
  });
});

describe('where a Launch shows (D-176, D-178)', () => {
  it('has a strip with a state and no person and no number', () => {
    for (const state of ['ready', 'lobby', 'live', 'finished'])
      expect(RoomLaunchStripSchema.safeParse({ state }).success).toBe(true);
    expect(RoomLaunchStripSchema.safeParse({ state: 'live', players: 3 }).success).toBe(false);
    expect(RoomLaunchStripSchema.safeParse({ state: 'paused' }).success).toBe(false);
  });

  it('is on a station and on a member room view only as a flag and a strip', () => {
    expect(RoomStationSchema.shape.live.safeParse(true).success).toBe(true);
    expect(RoomStationSchema.shape.live.safeParse(3).success).toBe(false);
  });

  it('adds a finished Launch to the acts that earn a star', () => {
    expect(RoomStarActSchema.safeParse('launch_finished').success).toBe(true);
  });
});
