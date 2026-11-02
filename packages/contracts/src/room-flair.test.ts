import { describe, expect, it } from 'vitest';
import {
  ChooseRoomFlairSchema,
  ROOM_FLAIR_KINDS,
  RoomFlairChosenAcceptanceSchema,
  RoomFlairViewSchema,
  RoomMessageStarSchema,
} from './room-flair.js';
import { RoomMessageSchema } from './rooms.js';
import { RoomStarSchema } from './room-sky.js';

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const scope = { accountId: id(1), privacyEpoch: 1 };
const read = { version: 'rooms.v1', readId: id(2), scope, status: 'ready' };
const asha = { kind: 'person', personId: id(7), handle: 'ci.asha', displayName: 'Asha' };

describe('flair (R3 E5, D-342)', () => {
  it('names four marks and no "Called it": that counts calls in Scrolls, which a room never reads', () => {
    expect(ROOM_FLAIR_KINDS).toEqual(['first_answer', 'good_question', 'flaw_finder', 'launch_regular']);
  });

  it('is a person’s own card: what is earned, what is partway with the rule’s own number, the choice and what shows', () => {
    const card = {
      ...read,
      earned: ['first_answer'],
      coming: [{ flair: 'flaw_finder', have: 2, of: 3 }],
      choice: 'none',
    };
    expect(RoomFlairViewSchema.safeParse(card).success).toBe(true);
    expect(RoomFlairViewSchema.safeParse({ ...card, shown: 'first_answer' }).success).toBe(true);
    expect(RoomFlairViewSchema.safeParse({ ...read, status: 'unavailable' }).success).toBe(true);
  });

  it('has no place for a total, a rank or a score of anyone', () => {
    const card = { ...read, earned: [], coming: [] };
    for (const field of ['karma', 'total', 'rank', 'points', 'level', 'leaderboard'])
      expect(RoomFlairViewSchema.safeParse({ ...card, [field]: 1 }).success, field).toBe(false);
    expect(RoomFlairViewSchema.safeParse({ ...card, earned: ['called_it'] }).success).toBe(false);
    // A mark that is only one step ("0 of 1") is not partway; the rule's number is at least two.
    expect(
      RoomFlairViewSchema.safeParse({ ...card, coming: [{ flair: 'first_answer', have: 0, of: 1 }] }).success,
    ).toBe(false);
  });

  it('chooses a mark, none or automatic, and refuses anything else', () => {
    const command = { version: 'rooms.v1', commandId: id(3), roomId: id(4) };
    for (const flair of [...ROOM_FLAIR_KINDS, 'none', 'auto'])
      expect(ChooseRoomFlairSchema.safeParse({ ...command, flair }).success, flair).toBe(true);
    for (const flair of ['called_it', 'karma', '', 'NONE'])
      expect(ChooseRoomFlairSchema.safeParse({ ...command, flair }).success, flair).toBe(false);
    expect(ChooseRoomFlairSchema.safeParse({ ...command, flair: 'none', on: true }).success).toBe(false);
    const receipt = { version: 'rooms.v1', scope, commandId: id(3), recordedAt: '2026-11-02T10:00:00.000Z' };
    expect(
      RoomFlairChosenAcceptanceSchema.safeParse({
        ...receipt,
        replayed: false,
        outcome: 'accepted',
        operation: 'room.flair',
        roomId: id(4),
        flair: 'auto',
      }).success,
    ).toBe(true);
  });
});

describe('what a message carries of flair and a star (R3 E5, F4)', () => {
  const available = {
    messageId: id(10),
    sequence: 1,
    status: 'available',
    author: asha,
    recordedAt: '2026-11-02T10:00:00.000Z',
    body: { kind: 'text', text: 'Parallax for the near ones' },
  };

  it('is one mark beside a person’s name and the place of a star among the seven', () => {
    expect(RoomMessageSchema.safeParse({ ...available, flair: 'first_answer', star: { place: 6 } }).success).toBe(true);
    expect(RoomMessageStarSchema.safeParse({ place: 7 }).success).toBe(true);
    expect(RoomMessageStarSchema.safeParse({ place: 8 }).success).toBe(false);
    expect(RoomMessageStarSchema.safeParse({ place: 0 }).success).toBe(false);
    expect(RoomMessageSchema.safeParse({ ...available, flair: 'karma' }).success).toBe(false);
  });

  it('has no place for who marked an answer', () => {
    expect(RoomMessageSchema.safeParse({ ...available, star: { place: 1, by: asha } }).success).toBe(false);
    expect(RoomMessageSchema.safeParse({ ...available, markedBy: asha }).success).toBe(false);
  });
});

describe('a star’s moment (D-341)', () => {
  const star = { day: '2026-10-25', constellation: 1 };

  it('names a person only on an answer found useful, a title only on a debate, and a count only on a Launch', () => {
    expect(
      RoomStarSchema.safeParse({ ...star, act: 'answer_useful', by: asha, opens: { discussionId: id(5) } }).success,
    ).toBe(true);
    expect(
      RoomStarSchema.safeParse({
        ...star,
        act: 'debate_closed',
        title: 'Is Pluto a planet?',
        opens: { discussionId: id(5) },
      }).success,
    ).toBe(true);
    expect(RoomStarSchema.safeParse({ ...star, act: 'launch_finished', played: 5 }).success).toBe(true);
    expect(RoomStarSchema.safeParse({ ...star, act: 'daily_solved' }).success).toBe(true);
    // A Launch names nobody (its podium is gone after the night), and a Spot the flaw opens nothing.
    expect(RoomStarSchema.safeParse({ ...star, act: 'launch_finished', played: 5, by: asha }).success).toBe(false);
    expect(RoomStarSchema.safeParse({ ...star, act: 'daily_solved', by: asha }).success).toBe(false);
    expect(RoomStarSchema.safeParse({ ...star, act: 'daily_solved', opens: { discussionId: id(5) } }).success).toBe(
      false,
    );
    expect(RoomStarSchema.safeParse({ ...star, act: 'answer_useful', title: 'x' }).success).toBe(false);
    expect(RoomStarSchema.safeParse({ ...star, act: 'answer_useful', played: 3 }).success).toBe(false);
  });

  it('is only the act and the day without a moment, and still holds no account', () => {
    expect(RoomStarSchema.safeParse({ ...star, act: 'answer_useful' }).success).toBe(true);
    expect(RoomStarSchema.safeParse({ ...star, act: 'answer_useful', accountId: id(1) }).success).toBe(false);
  });
});
