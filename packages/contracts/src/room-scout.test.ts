import { describe, expect, it } from 'vitest';
import {
  ModerateRoomSchema,
  ROOM_SCOUT_INTERESTS_MAX,
  RoomAuthorSchema,
  RoomFeedPostSchema,
  RoomLiveEventSchema,
  RoomMessageSchema,
  RoomModerationAcceptanceSchema,
  RoomScoutAcceptanceSchema,
  RoomScoutSchema,
  SCOUT_LABEL,
  SetRoomScoutSchema,
  ScoutAuthorSchema,
  roomsContract,
} from './rooms.js';

const ID = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SCOPE = { accountId: ID(9), privacyEpoch: 1 };
const ASHA = { kind: 'person', personId: ID(1), handle: 'asha', displayName: 'Asha' } as const;
const SCOUT = { kind: 'agent', sentBy: ASHA, label: SCOUT_LABEL } as const;
const card = {
  status: 'available',
  target: { assetId: ID(20), assetRevision: 1 },
  metadata: { kind: 'scroll', title: 'Weighing the halo', summary: 'A galaxy’s invisible halo.', language: 'en' },
} as const;
const choices = [{ id: 'astro.dark-matter', label: 'Dark matter' }];

describe('a scout as an author (v3 R-9, D-259)', () => {
  it('is signed by a person’s public profile and always carries the AI label', () => {
    expect(ScoutAuthorSchema.safeParse(SCOUT).success).toBe(true);
    expect(ScoutAuthorSchema.safeParse({ ...SCOUT, label: 'Scout' }).success).toBe(false);
    expect(ScoutAuthorSchema.safeParse({ kind: 'agent', label: SCOUT_LABEL }).success).toBe(false);
    expect(ScoutAuthorSchema.safeParse({ ...SCOUT, accountId: ID(2) }).success).toBe(false);
  });

  it('is a third kind of author beside a person and a resident, and never a person', () => {
    expect(RoomAuthorSchema.safeParse(SCOUT).success).toBe(true);
    expect(RoomAuthorSchema.safeParse(ASHA).success).toBe(true);
    expect(RoomAuthorSchema.safeParse({ kind: 'person', sentBy: ASHA, label: SCOUT_LABEL }).success).toBe(false);
  });

  it('writes a find in the feed and the Now strip, and a labelled message in a discussion', () => {
    const post = {
      kind: 'find',
      discussionId: ID(3),
      votes: 0,
      youVoted: false,
      canVote: true,
      author: SCOUT,
      postedAt: '2026-11-04T08:37:00.000Z',
      content: card,
      note: 'Worth a look.',
      replies: 0,
    };
    expect(RoomFeedPostSchema.safeParse(post).success).toBe(true);
    expect(RoomFeedPostSchema.safeParse({ ...post, author: ASHA }).success).toBe(false);
    expect(
      RoomLiveEventSchema.safeParse({ kind: 'posted', by: SCOUT, at: post.postedAt, discussionId: ID(3) }).success,
    ).toBe(true);
    const message = {
      messageId: ID(4),
      sequence: 1,
      status: 'available',
      author: SCOUT,
      recordedAt: post.postedAt,
      body: { kind: 'text', text: 'Worth a look.' },
      suggestion: 'find',
      trigger: 'scout_find',
    };
    expect(RoomMessageSchema.safeParse(message).success).toBe(true);
  });
});

describe('the reader’s own scout (v3 R-9, D-260)', () => {
  it('is none, with the room’s topics to choose from, or on, with the member’s choice', () => {
    expect(RoomScoutSchema.safeParse({ state: 'none', choices }).success).toBe(true);
    const on = {
      state: 'on',
      choices,
      interests: ['astro.dark-matter'],
      cadence: 'daily',
      paused: false,
      stopped: false,
    };
    expect(RoomScoutSchema.safeParse(on).success).toBe(true);
    expect(RoomScoutSchema.safeParse({ ...on, lastPostedAt: '2026-11-04T08:37:00.000Z' }).success).toBe(true);
    // The owner is told while their recording is paused; it is said only when true.
    expect(RoomScoutSchema.safeParse({ ...on, recordingPaused: true }).success).toBe(true);
    expect(RoomScoutSchema.safeParse({ ...on, recordingPaused: false }).success).toBe(false);
  });

  it('has one to five topics and a cadence of a day or a week, and nothing about what the member did', () => {
    const on = { state: 'on', choices, interests: ['a'], cadence: 'daily', paused: false, stopped: false };
    expect(RoomScoutSchema.safeParse({ ...on, interests: [] }).success).toBe(false);
    expect(RoomScoutSchema.safeParse({ ...on, interests: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(RoomScoutSchema.safeParse({ ...on, cadence: 'hourly' }).success).toBe(false);
    expect(RoomScoutSchema.safeParse({ ...on, readAt: 'x' }).success).toBe(false);
    expect(ROOM_SCOUT_INTERESTS_MAX).toBe(5);
  });

  it('is sent, changed or taken back by a command that names only the member’s own choice', () => {
    const base = { version: 'rooms.v1', commandId: ID(5), roomId: ID(1) };
    const scout = { interests: ['astro.dark-matter'], cadence: 'weekly', paused: false };
    expect(SetRoomScoutSchema.safeParse({ ...base, scout }).success).toBe(true);
    expect(SetRoomScoutSchema.safeParse({ ...base, scout: null }).success).toBe(true);
    expect(SetRoomScoutSchema.safeParse({ ...base, scout: { ...scout, interests: [] } }).success).toBe(false);
    expect(SetRoomScoutSchema.safeParse({ ...base, scout: { ...scout, fromUniverse: true } }).success).toBe(false);
    expect(SetRoomScoutSchema.safeParse({ ...base }).success).toBe(false);
    expect(
      RoomScoutAcceptanceSchema.safeParse({
        version: 'rooms.v1',
        scope: SCOPE,
        commandId: ID(5),
        recordedAt: '2026-11-04T08:37:00.000Z',
        replayed: false,
        outcome: 'accepted',
        operation: 'room.scout-set',
        roomId: ID(1),
        scout: { state: 'none', choices },
      }).success,
    ).toBe(true);
    expect(roomsContract.setScout).toBeDefined();
  });

  it('is stopped, or let go again, by a moderator naming a person', () => {
    const base = { version: 'rooms.v1', commandId: ID(5), roomId: ID(1) };
    for (const kind of ['stop_scout', 'allow_scout'] as const) {
      expect(ModerateRoomSchema.safeParse({ ...base, action: { kind, personId: ID(1) } }).success).toBe(true);
      expect(ModerateRoomSchema.safeParse({ ...base, action: { kind } }).success).toBe(false);
      expect(
        RoomModerationAcceptanceSchema.safeParse({
          version: 'rooms.v1',
          scope: SCOPE,
          commandId: ID(5),
          recordedAt: '2026-11-04T08:37:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'room.moderate',
          roomId: ID(1),
          action: kind,
        }).success,
      ).toBe(true);
    }
  });
});
