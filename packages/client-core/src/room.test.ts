import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createRoom, readRoomTopics } from './room';

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

  it('dismisses "while you were away" and the card goes from the view at once', async () => {
    const away = {
      resident: { kind: 'ai' as const, inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic' },
      since: '2026-10-23T20:00:00.000Z',
      state: 'preparing' as const,
    };
    const scope = scopeOf({
      read: () => Promise.resolve({ ...member, away }),
      dismissAway: () => Promise.resolve({}),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect((controller.getState().view as { away?: unknown }).away).toBeDefined();
    expect(await controller.dismissAway()).toBe(true);
    expect((controller.getState().view as { away?: unknown }).away).toBeUndefined();
    expect(scope.calls.find((call) => call.name === 'dismissAway')?.input).toMatchObject({ roomId });
  });

  it('leaves a question under one command until the server answers, and reads the room again', async () => {
    let up = false;
    const scope = scopeOf({
      read: () => Promise.resolve(member),
      leaveQuestion: () =>
        up ? Promise.resolve({ discussionId: id(88), asked: 'queued' }) : Promise.reject(new Error('network')),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    const question = { text: 'Why is the night sky dark?', askNow: true, notify: true };
    expect(await controller.leaveQuestion(question)).toBeUndefined();
    expect(controller.getState().offline).toBe(true);
    up = true;
    expect(await controller.leaveQuestion(question)).toEqual({ discussionId: id(88), asked: 'queued' });
    const sent = scope.calls.filter((call) => call.name === 'leaveQuestion');
    expect(sent).toHaveLength(2);
    // The same intent, so the same command: a retry after an unknown outcome never leaves it twice.
    expect((sent[1]?.input as { commandId: string }).commandId).toBe(
      (sent[0]?.input as { commandId: string }).commandId,
    );
    expect(sent[1]?.input).toMatchObject({ roomId, ...question });
    expect(scope.calls.filter((call) => call.name === 'read')).toHaveLength(2);
  });

  it('sets the notice switch and says an answer was noticed, each as its own command', async () => {
    const scope = scopeOf({
      read: () => Promise.resolve(member),
      questionNotice: () => Promise.resolve({ notify: false }),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    expect(await controller.setQuestionNotice(id(88), { notify: false })).toBe(true);
    expect(await controller.setQuestionNotice(id(88), { noticed: true })).toBe(true);
    const sent = scope.calls.filter((call) => call.name === 'questionNotice');
    expect(sent[0]?.input).toMatchObject({ roomId, discussionId: id(88), notify: false });
    expect(sent[1]?.input).toMatchObject({ roomId, discussionId: id(88), noticed: true });
    expect((sent[0]?.input as { commandId: string }).commandId).not.toBe(
      (sent[1]?.input as { commandId: string }).commandId,
    );
  });

  it('starts a topic from a message with a title and a tag under one command, and from nothing with a tag', async () => {
    const scope = scopeOf({
      read: () => Promise.resolve(member),
      createDiscussion: () => Promise.resolve({ discussionId: id(77) }),
    });
    const controller = createRoom({ scope, roomId, newId });
    await controller.load();
    const from = {
      kind: 'message' as const,
      discussionId: id(5),
      messageId: id(6),
      title: 'Is it the Moon?',
      tag: 'question' as const,
    };
    expect(await controller.startDiscussion(from)).toBe(id(77));
    expect(await controller.startDiscussion({ kind: 'topic', title: 'Tides', tag: 'share' })).toBe(id(77));
    expect(
      scope.calls
        .filter((call) => call.name === 'createDiscussion')
        .map((call) => (call.input as { start: unknown }).start),
    ).toEqual([from, { kind: 'topic', title: 'Tides', tag: 'share' }]);
  });

  it('reads the topics in the order and with the tag asked for, and says so when the server cannot', async () => {
    const topics = [{ discussionId: id(9), title: 'A topic', usefulCount: 2 }];
    let answer: () => Promise<unknown> = () => Promise.resolve({ status: 'ready', topics });
    const scope = scopeOf({ topics: () => answer() });
    expect(await readRoomTopics(scope, newId, roomId, { sort: 'hot', tag: 'debate' })).toEqual(topics);
    expect(scope.calls[0]?.input).toMatchObject({ roomId, sort: 'hot', tag: 'debate' });
    await readRoomTopics(scope, newId, roomId, { sort: 'new' });
    expect(scope.calls[1]?.input).not.toHaveProperty('tag');
    answer = () => Promise.resolve({ status: 'unavailable' });
    await expect(readRoomTopics(scope, newId, roomId, { sort: 'new' })).rejects.toThrow('ROOM_TOPICS_UNAVAILABLE');
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
