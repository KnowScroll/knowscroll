import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import { problemDetails, type ContentThreadRef, type ThreadMessage } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createContentThread } from './content-thread';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const thread: ContentThreadRef = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' };
const target = { assetId: id(30), assetRevision: 1 };
const root = {
  status: 'available' as const,
  target,
  metadata: { kind: 'reel' as const, title: 'The edge', summary: '', language: 'en' },
};
const cursor = (n: number) => `kcc1_${'A'.repeat(25)}${String(n)}`;

const unavailable = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });

const ravi = { kind: 'person' as const, personId: id(11), handle: 'ci.ravi', displayName: 'Ravi fixture' };
const text = (sequence: number, value: string, author = asha): ThreadMessage => ({
  messageId: id(100 + sequence),
  sequence,
  status: 'available',
  author,
  recordedAt: '2026-10-24T08:00:00.000Z',
  body: { kind: 'text', text: value },
});

type AvailableThreadMessage = Extract<ThreadMessage, { status: 'available' }>;
const available = (sequence: number, value: string, author = asha) =>
  text(sequence, value, author) as AvailableThreadMessage;

function readyView(messages: ThreadMessage[], extra: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    thread,
    root,
    participants: [{ person: asha, role: 'starter', joined: true, you: true }],
    sequence: { kind: 'single' },
    episodes: [{ ...target, kind: 'reel', title: 'The edge', state: 'ready', visited: false }],
    own: { readThroughSequence: 0, muted: false },
    latestMessageSequence: messages.at(-1)?.sequence ?? 0,
    messages,
    limit: 30,
    history: { kind: 'end' },
    catchUpCursor: cursor(messages.length),
    ...extra,
  };
}

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(threads: Api): AccountScope & { calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(threads).map(([name, handler]) => [
      name,
      (input: never) => {
        calls.push({ name, input });
        return handler(input);
      },
    ]),
  );
  return { active: true, api: { threads: wrapped }, calls } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
  };
}
let counter = 1000;
const newId = () => id(counter++);

describe('a content thread on the client', () => {
  it('reads the thread and settles a sent bubble when its message arrives', async () => {
    const stored: ThreadMessage[] = [];
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(stored)),
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
      markRead: () => Promise.resolve({ acceptedThroughSequence: stored.length }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', name: undefined, sequence: 'single' });
    expect(controller.getState().episodes).toHaveLength(1);

    await controller.send({ kind: 'text', text: 'hello' });
    const state = controller.getState();
    expect(state.messages.map((message) => message.sequence)).toEqual([1]);
    expect(state.outgoing).toEqual([]);
  });

  it('keeps a lost send as one bubble and retries the identical command', async () => {
    let attempts = 0;
    const seen: string[] = [];
    const scope = scopeOf({
      read: () => Promise.resolve(readyView([])),
      send: (input: { commandId: string }) => {
        seen.push(input.commandId);
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('network')) : Promise.resolve({ messageSequence: 1 });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: [{ changeSequence: 1, message: text(1, 'hello') }],
          continuation: { kind: 'caught_up', cursor: cursor(1) },
        }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.send({ kind: 'text', text: 'hello' });
    expect(controller.getState().outgoing).toMatchObject([{ status: 'unconfirmed' }]);
    await controller.retry(controller.getState().outgoing[0]!.commandId);
    expect(seen[0]).toBe(seen[1]);
    expect(controller.getState().outgoing).toEqual([]);
  });

  it('shows only the invitation until the person joins, then reads the thread', async () => {
    let joined = false;
    const scope = scopeOf({
      read: () =>
        Promise.resolve(
          joined
            ? readyView([text(1, 'welcome')])
            : { status: 'invitation', thread, root, name: 'The edge', invitedBy: asha, participantCount: 2 },
        ),
      respond: () => {
        joined = true;
        return Promise.resolve({ response: 'join' });
      },
      markRead: () => Promise.resolve({ acceptedThroughSequence: 1 }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'invitation', invitedBy: asha, name: 'The edge' });
    expect(controller.getState().messages).toEqual([]);
    expect(await controller.respond('join')).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: 'ready' });
    expect(controller.getState().messages).toHaveLength(1);
  });

  it('reuses the command of an answer whose outcome is unknown, and reads again when it is refused', async () => {
    const commandIds: string[] = [];
    let call = 0;
    const scope = scopeOf({
      read: () => Promise.resolve({ status: 'invitation', thread, root, invitedBy: asha, participantCount: 2 }),
      respond: (input: { commandId: string }) => {
        commandIds.push(input.commandId);
        call++;
        return call === 1 ? Promise.reject(new Error('network')) : Promise.reject(unavailable());
      },
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    expect(await controller.respond('join')).toBe(false);
    expect(await controller.respond('join')).toBe(false);
    expect(commandIds[0]).toBe(commandIds[1]);
    // A refusal means the invitation changed: the thread was read again and is still the invitation.
    expect(controller.getState().phase).toBe('invitation');
  });

  it('starts over from a fresh snapshot when the server calls the position stale', async () => {
    let reads = 0;
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(reads++ === 0 ? [text(1, 'one')] : [text(1, 'one'), text(2, 'two')])),
      changes: () => Promise.resolve({ status: 'refresh_required' }),
      markRead: () => Promise.resolve({ acceptedThroughSequence: 2 }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.refresh();
    expect(reads).toBe(2);
    expect(controller.getState().messages.map((message) => message.sequence)).toEqual([1, 2]);
  });

  it('says unavailable, without a reason, when the server refuses', async () => {
    const scope = scopeOf({ read: () => Promise.reject(unavailable()) });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    expect(controller.getState().phase).toBe('unavailable');
  });

  it('marks the newest message read only while the thread is on screen', async () => {
    const scope = scopeOf({
      read: () => Promise.resolve(readyView([text(1, 'one')])),
      markRead: () => Promise.resolve({ acceptedThroughSequence: 1 }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    expect(scope.calls.filter((call) => call.name === 'markRead')).toHaveLength(0);
    controller.setActive(true);
    await Promise.resolve();
    expect(scope.calls.filter((call) => call.name === 'markRead')).toHaveLength(1);
  });
  it('marks where a lost connection left off, only when something arrived after it', async () => {
    let lost = false;
    const stored = [text(1, 'one')];
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(stored)),
      changes: () =>
        lost
          ? Promise.reject(new Error('network'))
          : Promise.resolve({
              status: 'ready',
              changes: stored.map((message) => ({ changeSequence: message.sequence, message })),
              continuation: { kind: 'caught_up', cursor: cursor(stored.length) },
            }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.refresh();
    expect(controller.getState().awayAfterSequence).toBeUndefined();

    lost = true;
    await controller.refresh();
    expect(controller.getState().offline).toBe(true);
    lost = false;
    await controller.refresh();
    expect(controller.getState()).toMatchObject({ offline: false, awayAfterSequence: undefined });

    lost = true;
    await controller.refresh();
    stored.push(text(2, 'two', ravi), text(3, 'three', ravi));
    lost = false;
    await controller.refresh();
    expect(controller.getState().awayAfterSequence).toBe(1);
  });

  it('draws no divider for the person’s own message that only settled after the reconnect', async () => {
    let lost = false;
    const stored = [text(1, 'one')];
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(stored)),
      changes: () =>
        lost
          ? Promise.reject(new Error('network'))
          : Promise.resolve({
              status: 'ready',
              changes: stored.map((message) => ({ changeSequence: message.sequence, message })),
              continuation: { kind: 'caught_up', cursor: cursor(stored.length) },
            }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    lost = true;
    await controller.refresh();
    stored.push(text(2, 'mine, settled late'));
    lost = false;
    await controller.refresh();
    expect(controller.getState()).toMatchObject({ offline: false, awayAfterSequence: undefined });
  });

  it('sends a reply naming its original and a retry names the same one', async () => {
    const stored = [text(1, 'who is on part 2?', ravi)];
    let failures = 1;
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(stored)),
      send: (input: { body: { text: string }; replyTo?: string }) => {
        if (failures-- > 0) return Promise.reject(new Error('network'));
        stored.push({
          ...available(2, input.body.text),
          replyTo: {
            messageId: input.replyTo!,
            sequence: 1,
            original: { status: 'available', author: ravi, preview: 'who is on part 2?' },
          },
        });
        return Promise.resolve({ messageSequence: 2, replayed: false });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: stored.map((message) => ({ changeSequence: message.sequence, message })),
          continuation: { kind: 'caught_up', cursor: cursor(stored.length) },
        }),
      markRead: () => Promise.resolve({ acceptedThroughSequence: stored.length }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.send({ kind: 'text', text: 'part 2 abhi start kiya' }, id(101));
    const [pending] = controller.getState().outgoing;
    expect(pending).toMatchObject({ status: 'unconfirmed', replyTo: id(101) });
    await controller.retry(pending!.commandId);
    const sends = scope.calls
      .filter((call) => call.name === 'send')
      .map((call) => call.input as Record<string, unknown>);
    expect(sends.map((input) => input['replyTo'])).toEqual([id(101), id(101)]);
    expect(new Set(sends.map((input) => input['commandId'])).size).toBe(1);
    expect(controller.getState().messages[1]).toMatchObject({ replyTo: { messageId: id(101) } });
  });

  it('sends a refused reply again as a plain message, under a new command', async () => {
    const stored: ThreadMessage[] = [];
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(stored)),
      send: (input: { body: { text: string }; replyTo?: string }) => {
        if (input.replyTo !== undefined) return Promise.reject(unavailable());
        stored.push(text(stored.length + 1, input.body.text));
        return Promise.resolve({ messageSequence: stored.length, replayed: false });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: stored.map((message) => ({ changeSequence: message.sequence, message })),
          continuation: { kind: 'caught_up', cursor: cursor(stored.length) },
        }),
      markRead: () => Promise.resolve({ acceptedThroughSequence: stored.length }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.send({ kind: 'text', text: 'a reply to something gone' }, id(101));
    const [refused] = controller.getState().outgoing;
    expect(refused).toMatchObject({ status: 'not_sent', replyTo: id(101) });
    await controller.sendWithoutQuote(refused!.commandId);
    await controller.sendWithoutQuote(refused!.commandId);
    const sends = scope.calls
      .filter((call) => call.name === 'send')
      .map((call) => call.input as Record<string, unknown>);
    expect(sends.map((input) => input['replyTo'])).toEqual([id(101), undefined]);
    expect(new Set(sends.map((input) => input['commandId'])).size).toBe(2);
    expect(controller.getState().outgoing).toEqual([]);
    expect(controller.getState().messages.map((message) => message.status)).toEqual(['available']);
  });

  it('reacts with the wanted state, then catches up so the message comes back with the reaction', async () => {
    const stored: ThreadMessage[] = [text(1, 'the far side bulges too')];
    const scope = scopeOf({
      read: () => Promise.resolve(readyView(stored)),
      react: (input: { present: boolean; kind: 'heart' }) => {
        stored[0] = input.present
          ? {
              ...available(1, 'the far side bulges too'),
              reactions: [{ kind: input.kind, mine: true, people: [asha] }],
            }
          : available(1, 'the far side bulges too');
        return Promise.resolve({ changed: true });
      },
      changes: () =>
        Promise.resolve({
          status: 'ready',
          changes: stored.map((message, index) => ({ changeSequence: index + 2, message })),
          continuation: { kind: 'caught_up', cursor: cursor(stored.length + 1) },
        }),
      markRead: () => Promise.resolve({ acceptedThroughSequence: 1 }),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.react(id(101), 'heart', true);
    expect(controller.getState().messages[0]).toMatchObject({ reactions: [{ kind: 'heart', mine: true }] });
    await controller.react(id(101), 'heart', false);
    expect(controller.getState().messages[0]).not.toHaveProperty('reactions');
    const reacts = scope.calls
      .filter((call) => call.name === 'react')
      .map((call) => call.input as Record<string, unknown>);
    expect(reacts.map((input) => [input['messageId'], input['kind'], input['present']])).toEqual([
      [id(101), 'heart', true],
      [id(101), 'heart', false],
    ]);
  });

  it('reads the thread again when a reaction is refused, because the place may have ended', async () => {
    const scope = scopeOf({
      read: () => Promise.resolve(readyView([text(1, 'hello')])),
      react: () => Promise.reject(unavailable()),
    });
    const controller = createContentThread({ scope, thread, newId });
    await controller.load();
    await controller.react(id(101), 'spark', true);
    await vi.waitFor(() => expect(scope.calls.filter((call) => call.name === 'read')).toHaveLength(2));
  });
});
