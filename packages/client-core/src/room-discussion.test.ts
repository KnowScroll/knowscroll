import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type RoomMessage } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createRoomDiscussion, mergeRoomMessages } from './room-discussion';

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const discussionId = id(2);
const room = {
  roomId,
  name: 'Machine learning room',
  description: 'How computers learn.',
  topic: { kind: 'system' as const, id: 'machine-learning', label: 'Machine learning' },
  joinRule: 'open' as const,
  status: 'open' as const,
};
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' };
const cursor = (n: number) => `krc1_${'A'.repeat(25)}${String(n)}`;

const text = (sequence: number, value: string): RoomMessage => ({
  messageId: id(100 + sequence),
  sequence,
  status: 'available',
  author: asha,
  recordedAt: '2026-10-24T08:00:00.000Z',
  body: { kind: 'text', text: value },
});
const removed = (sequence: number): RoomMessage => ({ messageId: id(100 + sequence), sequence, status: 'removed' });
const gone = (sequence: number): RoomMessage => ({ messageId: id(100 + sequence), sequence, status: 'unavailable' });

const inhabitants = (ask: 'available' | 'preparing' | 'resting') =>
  (['explainer', 'skeptic'] as const).map((inhabitant) => ({
    inhabitant,
    label: inhabitant === 'explainer' ? 'AI · Explainer' : 'AI · Skeptic',
    blurb: 'x',
    ask,
  }));

function readyView(messages: RoomMessage[], extra: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    room,
    role: 'member',
    you: asha,
    discussion: { discussionId, title: 'Where should it run?', pinned: false },
    canPost: true,
    inhabitants: inhabitants('available'),
    latestMessageSequence: messages.at(-1)?.sequence ?? 0,
    messages,
    limit: 30,
    history: { kind: 'end' },
    catchUpCursor: cursor(messages.length),
    ...extra,
  };
}

const rejected = (code: 'SHARING_UNAVAILABLE' | 'TOO_MANY_REQUESTS') =>
  new ORPCError(code, { status: 429, data: problemDetails(code) });

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
let counter = 1000;
const newId = () => id(counter++);

describe('merging room messages', () => {
  it('lets a moderator’s hide and restore reach the screen, but never brings back a deleted account’s words', () => {
    const base = [text(1, 'one'), text(2, 'two')];
    expect(mergeRoomMessages(base, [removed(2)]).map((message) => message.status)).toEqual(['available', 'removed']);
    expect(mergeRoomMessages([text(1, 'one'), removed(2)], [text(2, 'two')]).map((message) => message.status)).toEqual([
      'available',
      'available',
    ]);
    expect(mergeRoomMessages([gone(1)], [text(1, 'one')])[0]?.status).toBe('unavailable');
    expect(mergeRoomMessages([text(2, 'b'), text(1, 'a')], []).map((message) => message.sequence)).toEqual([1, 2]);
  });
});

describe('a room discussion on the client', () => {
  it('reads the discussion and settles a sent bubble when its message arrives', async () => {
    const stored: RoomMessage[] = [];
    const scope = scopeOf({
      readDiscussion: () => Promise.resolve(readyView(stored)),
      send: (input: { body: { text: string } }) => {
        stored.push(text(stored.length + 1, input.body.text));
        return Promise.resolve({ messageSequence: stored.length, replayed: false });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: stored.map((message) => ({ changeSequence: message.sequence, message })),
          continuation: { kind: 'caught_up', cursor: cursor(stored.length) },
        }),
    });
    const controller = createRoomDiscussion({ scope, roomId, discussionId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', messages: [] });
    await controller.send({ kind: 'text', text: 'hello room' });
    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().outgoing).toEqual([]);
  });

  it('keeps a failed send as one bubble and retries it with the same command', async () => {
    let attempts = 0;
    const stored: RoomMessage[] = [];
    const scope = scopeOf({
      readDiscussion: () => Promise.resolve(readyView(stored)),
      send: (input: { body: { text: string } }) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new TypeError('network'));
        stored.push(text(1, input.body.text));
        return Promise.resolve({ messageSequence: 1, replayed: false });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: stored.map((message) => ({ changeSequence: message.sequence, message })),
          continuation: { kind: 'caught_up', cursor: cursor(stored.length) },
        }),
    });
    const controller = createRoomDiscussion({ scope, roomId, discussionId, newId });
    await controller.load();
    await controller.send({ kind: 'text', text: 'again' });
    const [bubble] = controller.getState().outgoing;
    expect(bubble).toMatchObject({ status: 'unconfirmed' });
    await controller.retry(bubble!.commandId);
    expect(controller.getState().outgoing).toEqual([]);
    const sends = scope.calls
      .filter((call) => call.name === 'send')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(sends[0]).toBe(sends[1]);
  });

  it('reads the discussion again while an inhabitant is preparing, so its reply and the end of the wait show', async () => {
    let preparing = true;
    const scope = scopeOf({
      readDiscussion: () =>
        Promise.resolve(readyView([], { inhabitants: inhabitants(preparing ? 'preparing' : 'available') })),
      changes: () =>
        Promise.resolve({ status: 'ready', changes: [], continuation: { kind: 'caught_up', cursor: cursor(0) } }),
    });
    const controller = createRoomDiscussion({ scope, roomId, discussionId, newId });
    await controller.load();
    preparing = false;
    await controller.refresh();
    expect(controller.getState().view?.inhabitants.map((entry) => entry.ask)).toEqual(['available', 'available']);
    const reads = scope.calls.filter((call) => call.name === 'readDiscussion').length;
    await controller.refresh();
    expect(scope.calls.filter((call) => call.name === 'readDiscussion')).toHaveLength(reads);
  });

  it('asks an inhabitant, reads again, and tells a rested inhabitant from an unavailable one', async () => {
    let answer: () => Promise<unknown> = () => Promise.resolve({ inhabitant: 'skeptic' });
    const scope = scopeOf({
      readDiscussion: () => Promise.resolve(readyView([])),
      askInhabitant: () => answer(),
    });
    const controller = createRoomDiscussion({ scope, roomId, discussionId, newId });
    await controller.load();
    expect(await controller.ask('skeptic')).toBe('asked');
    answer = () => Promise.reject(rejected('TOO_MANY_REQUESTS'));
    expect(await controller.ask('skeptic')).toBe('resting');
    answer = () => Promise.reject(rejected('SHARING_UNAVAILABLE'));
    expect(await controller.ask('explainer')).toBe('unavailable');
    answer = () => Promise.reject(new TypeError('network'));
    expect(await controller.ask('skeptic')).toBe('failed');
  });

  it('shows the discussion as unavailable when the server refuses a read without saying why', async () => {
    const scope = scopeOf({ readDiscussion: () => Promise.reject(rejected('SHARING_UNAVAILABLE')) });
    const controller = createRoomDiscussion({ scope, roomId, discussionId, newId });
    await controller.load();
    expect(controller.getState().phase).toBe('unavailable');
  });

  it('applies a moderator’s hide to the catch-up and returns whether it was accepted', async () => {
    const stored = [text(1, 'fine'), text(2, 'not fine')];
    const scope = scopeOf({
      readDiscussion: () => Promise.resolve(readyView(stored)),
      hideMessage: () => {
        stored[1] = removed(2);
        return Promise.resolve({ hidden: true });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: [{ changeSequence: 3, message: stored[1] }],
          continuation: { kind: 'caught_up', cursor: cursor(3) },
        }),
    });
    const controller = createRoomDiscussion({ scope, roomId, discussionId, newId });
    await controller.load();
    expect(await controller.hide(stored[1]!.messageId, true)).toBe(true);
    expect(controller.getState().messages.map((message) => message.status)).toEqual(['available', 'removed']);
  });
});
