import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ROOM_COUNT_AND_ACTIVITY_FIELDS,
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

/** The node kinds of a zod v4 schema the walk below looks into; any other composite kind fails the test loudly. */
interface Def {
  readonly type: string;
  readonly shape?: Record<string, z.ZodType>;
  readonly options?: readonly z.ZodType[];
  readonly element?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly out?: z.ZodType;
  readonly left?: z.ZodType;
  readonly right?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly items?: readonly z.ZodType[];
  readonly entries?: unknown;
}
const LEAVES = new Set(['string', 'number', 'int', 'boolean', 'literal', 'enum', 'null', 'undefined', 'date', 'any']);
/** A key speaks of a count or of activity when one of its camelCase words does, or it starts with lastMessage or lastActivity. */
const SPEAKS_OF_PEOPLE_OR_ACTIVITY = (key: string): boolean =>
  /^last(Message|Activity)/.test(key) ||
  (key.match(/[A-Z]?[a-z]+/g) ?? []).some((word) =>
    /^(count|total|online|here|active|unread|seen)$/.test(word.toLowerCase()),
  );

/** Every key path of a schema whose name matches, with the `status` branch it sits on. */
function matchingKeys(schema: z.ZodType, path: string, view: string | undefined, found: string[]): void {
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  if (LEAVES.has(def.type)) return;
  if (def.type === 'object') {
    const shape = def.shape ?? {};
    const status =
      shape['status'] === undefined
        ? undefined
        : (shape['status'] as unknown as { _zod: { def: { values?: string[] } } })._zod.def.values?.[0];
    const here = status ?? view;
    for (const [key, child] of Object.entries(shape)) {
      const next = path === '' ? key : `${path}.${key}`;
      if (SPEAKS_OF_PEOPLE_OR_ACTIVITY(key)) found.push(`${here ?? ''}|${next}`);
      matchingKeys(child, next, here, found);
    }
    return;
  }
  const inner = [
    def.element,
    def.innerType,
    def.in,
    def.left,
    def.right,
    def.valueType,
    ...(def.options ?? []),
    ...(def.items ?? []),
  ];
  const composite = [
    'union',
    'array',
    'optional',
    'nullable',
    'readonly',
    'default',
    'pipe',
    'intersection',
    'record',
    'tuple',
  ];
  if (!composite.includes(def.type)) throw new Error(`The walk does not know zod kind "${def.type}" at ${path}`);
  for (const child of inner) if (child !== undefined) matchingKeys(child, path, view, found);
}

describe('the allow-list of counts and activity (D-069)', () => {
  const found = (): string[] => {
    const all: string[] = [];
    for (const [route, procedure] of Object.entries(roomsContract)) {
      const keys: string[] = [];
      matchingKeys((procedure as { '~orpc': { outputSchema: z.ZodType } })['~orpc'].outputSchema, '', undefined, keys);
      all.push(...keys.map((key) => `${route}|${key}`));
    }
    return [...new Set(all)].sort();
  };

  it('names every answer key that speaks of a count, a total, presence or activity, and no other', () => {
    const allowed = ROOM_COUNT_AND_ACTIVITY_FIELDS.map(
      (field) => `${field.route}|${field.view ?? ''}|${field.path}`,
    ).sort();
    expect(found()).toEqual(allowed);
  });

  it("puts the room's own counts only on the member view, never on a list, a preview or a station", () => {
    const onRead = found().filter((entry) => entry.startsWith('read|'));
    expect(onRead.length).toBeGreaterThan(0);
    expect(onRead.every((entry) => entry.startsWith('read|member|'))).toBe(true);
    for (const route of ['list', 'stations', 'join', 'leave', 'invite', 'moderate', 'activities', 'readActivity'])
      expect(
        found().filter((entry) => entry.startsWith(`${route}|`)),
        route,
      ).toEqual([]);
  });
});
