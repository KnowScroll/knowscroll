import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createRoom } from './room';

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const room = {
  roomId,
  name: 'Machine learning room',
  description: 'How computers learn.',
  topic: { kind: 'system' as const, id: 'machine-learning', label: 'Machine learning' },
  joinRule: 'open' as const,
  status: 'open' as const,
};
const preview = {
  status: 'preview' as const,
  room,
  hasModerator: false,
  inhabitants: [],
  invited: false,
  join: { allowed: true as const },
};
const member = {
  status: 'member' as const,
  room,
  role: 'member' as const,
  hasModerator: false,
  inhabitants: [],
  discussions: [],
  canPost: true,
};

const unavailable = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(rooms: Api): AccountScope & { calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(rooms).map(([name, handler]) => [
      name,
      (input: never) => {
        calls.push({ name, input });
        return handler(input);
      },
    ]),
  );
  return { active: true, api: { rooms: wrapped }, calls } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
  };
}
let counter = 100;
const newId = () => id(counter++);

describe('a room on the client', () => {
  it('shows a preview to an outsider and the room to a member, and says nothing of why a room is unavailable', async () => {
    let answer: object = preview;
    const scope = scopeOf({ read: () => Promise.resolve(answer) });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'preview', view: { join: { allowed: true } } });
    answer = member;
    await controller.load();
    expect(controller.getState().phase).toBe('member');
    answer = { status: 'unavailable' };
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', view: undefined });
  });

  it('joins and then reads the room again', async () => {
    let joined = false;
    const scope = scopeOf({
      read: () => Promise.resolve(joined ? member : preview),
      join: () => {
        joined = true;
        return Promise.resolve({ role: 'member' });
      },
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.join()).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: 'member', working: false, refused: false });
  });

  it('retries an unconfirmed join with the same command, so a lost answer cannot join twice', async () => {
    let attempts = 0;
    const scope = scopeOf({
      read: () => Promise.resolve(preview),
      join: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new TypeError('network')) : Promise.resolve({ role: 'member' });
      },
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.join()).toBe(false);
    expect(controller.getState()).toMatchObject({ offline: true, refused: false });
    expect(await controller.join()).toBe(true);
    const commands = scope.calls
      .filter((call) => call.name === 'join')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
  });

  it('reads the room again after a refusal and marks it, using a new command next time', async () => {
    const scope = scopeOf({ read: () => Promise.resolve(preview), join: () => Promise.reject(unavailable()) });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.join()).toBe(false);
    expect(controller.getState().refused).toBe(true);
    expect(scope.calls.filter((call) => call.name === 'read')).toHaveLength(2);
    await controller.join();
    const commands = scope.calls
      .filter((call) => call.name === 'join')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(commands[0]).not.toBe(commands[1]);
  });

  it('starts a discussion and returns its ID', async () => {
    const discussionId = id(50);
    const scope = scopeOf({
      read: () => Promise.resolve(member),
      createDiscussion: () => Promise.resolve({ discussionId }),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.startDiscussion({ kind: 'topic', title: 'Where should it run?' })).toBe(discussionId);
  });

  it('does not run two commands at once', async () => {
    let release: () => void = () => undefined;
    const scope = scopeOf({
      read: () => Promise.resolve(preview),
      join: () => new Promise((resolve) => (release = () => resolve({ role: 'member' }))),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    const first = controller.join();
    expect(await controller.leave()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(scope.calls.filter((call) => call.name === 'leave')).toHaveLength(0);
  });
  it('changes a member’s own settings and shows the new ones at once, without reading the room again', async () => {
    const you = { aiLevel: 'quieter' as const, keepOut: true };
    const scope = scopeOf({
      read: () => Promise.resolve({ ...member, you: { aiLevel: 'lively', keepOut: false } }),
      preferences: () => Promise.resolve({ you }),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.setPreferences({ aiLevel: 'quieter', keepOut: true })).toBe(true);
    expect(controller.getState().view).toMatchObject({ you });
    expect(scope.calls.filter((call) => call.name === 'read')).toHaveLength(1);
    expect(scope.calls.find((call) => call.name === 'preferences')?.input).toMatchObject({
      roomId,
      aiLevel: 'quieter',
      keepOut: true,
    });
  });

  it('retries an unconfirmed settings change with the same command', async () => {
    let attempts = 0;
    const scope = scopeOf({
      read: () => Promise.resolve(member),
      preferences: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError('network'))
          : Promise.resolve({ you: { aiLevel: 'off', keepOut: false } });
      },
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.setPreferences({ aiLevel: 'off' })).toBe(false);
    expect(await controller.setPreferences({ aiLevel: 'off' })).toBe(true);
    const commands = scope.calls
      .filter((call) => call.name === 'preferences')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(commands[0]).toBe(commands[1]);
  });

  it('keeps the lease with plain here and away calls, and a missed beat changes nothing on screen', async () => {
    let fail = false;
    const scope = scopeOf({
      read: () => Promise.resolve(member),
      presence: () => (fail ? Promise.reject(unavailable()) : Promise.resolve({})),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    await controller.setPresence('here');
    fail = true;
    await controller.setPresence('away');
    expect(
      scope.calls.filter((call) => call.name === 'presence').map((call) => (call.input as { state: string }).state),
    ).toEqual(['here', 'away']);
    // A refusal of a beat is not an answer about the room: the screen still shows it.
    expect(controller.getState()).toMatchObject({ phase: 'member', offline: false, refused: false });
  });
});
