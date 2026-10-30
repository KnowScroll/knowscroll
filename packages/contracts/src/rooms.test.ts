import { describe, expect, it } from 'vitest';
import {
  ROOM_HERE_COUNT_FROM,
  RoomHereSchema,
  RoomViewSchema,
  SetRoomPreferencesSchema,
  SetRoomPresenceSchema,
  roomsContract,
} from './rooms.js';

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const face = (n: number, you = false) => ({
  person: {
    kind: 'person' as const,
    personId: id(n),
    handle: `ci.person${String(n)}`,
    displayName: `Person ${String(n)}`,
  },
  you,
});

describe('who is here (D-069)', () => {
  it('allows faces without a number below three people and refuses a number there', () => {
    expect(RoomHereSchema.safeParse({ faces: [] }).success).toBe(true);
    expect(RoomHereSchema.safeParse({ faces: [face(1, true)] }).success).toBe(true);
    expect(RoomHereSchema.safeParse({ faces: [face(1, true), face(2)] }).success).toBe(true);
    // "1 online" and "0 online" cannot be said: no count below the threshold, whatever the faces are.
    for (const count of [0, 1, 2]) {
      expect(RoomHereSchema.safeParse({ faces: [], count }).success, String(count)).toBe(false);
      expect(RoomHereSchema.safeParse({ faces: [face(1, true), face(2)], count }).success, String(count)).toBe(false);
    }
  });

  it('requires the number from three faces, and never one smaller than the faces shown', () => {
    const three = [face(1, true), face(2), face(3)];
    expect(RoomHereSchema.safeParse({ faces: three }).success).toBe(false);
    expect(RoomHereSchema.safeParse({ faces: three, count: ROOM_HERE_COUNT_FROM }).success).toBe(true);
    expect(RoomHereSchema.safeParse({ faces: three, count: 40 }).success).toBe(true);
    expect(RoomHereSchema.safeParse({ faces: [...three, face(4)], count: 3 }).success).toBe(false);
  });

  it('has no place for an AI inhabitant among the faces', () => {
    const ai = { person: { kind: 'ai', inhabitant: 'explainer', label: 'AI · Explainer' }, you: false };
    expect(RoomHereSchema.safeParse({ faces: [face(1, true), ai] }).success).toBe(false);
  });

  it('puts the allow-listed fields on a member view only: a preview carries no count or activity', () => {
    const preview = {
      version: 'rooms.v1',
      scope: { accountId: id(1), privacyEpoch: 1 },
      readId: id(2),
      status: 'preview',
      room: {
        roomId: id(3),
        name: 'Room',
        description: 'A room',
        topic: { kind: 'system', id: 'machine-learning', label: 'Machine learning' },
        joinRule: 'open',
        status: 'open',
      },
      hasModerator: false,
      inhabitants: [],
      invited: false,
      join: { allowed: true },
    };
    expect(RoomViewSchema.safeParse(preview).success).toBe(true);
    for (const field of ['here', 'memberTotal', 'lastMessageAt', 'you'])
      expect(RoomViewSchema.safeParse({ ...preview, [field]: 1 }).success, field).toBe(false);
  });
});

describe('a member’s own settings and presence', () => {
  const command = { version: 'rooms.v1' as const, commandId: id(9), roomId: id(3) };

  it('needs at least one thing to change, and takes the notice only as read', () => {
    expect(SetRoomPreferencesSchema.safeParse(command).success).toBe(false);
    expect(SetRoomPreferencesSchema.safeParse({ ...command, aiLevel: 'off' }).success).toBe(true);
    expect(SetRoomPreferencesSchema.safeParse({ ...command, keepOut: false }).success).toBe(true);
    expect(SetRoomPreferencesSchema.safeParse({ ...command, noticeSeen: true }).success).toBe(true);
    expect(SetRoomPreferencesSchema.safeParse({ ...command, noticeSeen: false }).success).toBe(false);
    expect(SetRoomPreferencesSchema.safeParse({ ...command, aiLevel: 'loud' }).success).toBe(false);
  });

  it('says only here or away about a room, with no clock time from the client', () => {
    const base = { version: 'rooms.v1' as const, roomId: id(3) };
    expect(SetRoomPresenceSchema.safeParse({ ...base, state: 'here' }).success).toBe(true);
    expect(SetRoomPresenceSchema.safeParse({ ...base, state: 'away' }).success).toBe(true);
    expect(SetRoomPresenceSchema.safeParse({ ...base, state: 'online' }).success).toBe(false);
    expect(SetRoomPresenceSchema.safeParse({ ...base, state: 'here', at: '2026-10-24T08:00:00Z' }).success).toBe(false);
  });

  it('serves the new routes beside the old ones', () => {
    expect(Object.keys(roomsContract)).toEqual(expect.arrayContaining(['preferences', 'presence', 'read', 'send']));
  });
});
