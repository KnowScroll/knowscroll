import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@knowscroll/contracts';
import { createConversationThread, mergeMessages } from './conversation-thread';
import { conversation, me, peer, talkServer } from './test-support/talk-fixture';

let counter = 0;
const newId = () => `0199a000-0000-7000-8000-${(++counter + 5000).toString(16).padStart(12, '0')}`;
const servers: ReturnType<typeof talkServer>[] = [];
function setup() {
  const server = talkServer();
  servers.push(server);
  const thread = createConversationThread({ scope: server.scope, conversation, newId });
  return { server, thread };
}
afterEach(() => {
  for (const server of servers.splice(0)) server.scope.end();
});
const text = (value: string) => ({ kind: 'text' as const, text: value });

describe('conversation thread (labelled in-memory server)', () => {
  it('loads the newest messages and the peer, oldest first, and reports an empty thread as ready', async () => {
    const { server, thread } = setup();
    await thread.load();
    expect(thread.getState()).toMatchObject({ phase: 'ready', peer, messages: [], hasOlder: false, ended: false });
    for (const word of ['one', 'two', 'three']) server.peerSays(word);
    await thread.load();
    expect(thread.getState().messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
  });

  it('shows how far the other person has read only while the server says so, from a read and from catch-up', async () => {
    const { server, thread } = setup();
    server.peerSays('one');
    await thread.load();
    await thread.send(text('two'));
    expect(thread.getState().peerReadThrough).toBeUndefined();
    // Both share and the peer read to the person's own message: catch-up carries it, with no new message.
    server.peerReadsThrough(2);
    await thread.refresh();
    expect(thread.getState().peerReadThrough).toBe(2);
    // Either person hides theirs: the next read says nothing, and the screen forgets it.
    server.peerReadsThrough(undefined);
    await thread.refresh();
    expect(thread.getState().peerReadThrough).toBeUndefined();
    // A fresh snapshot carries it too.
    server.peerReadsThrough(1);
    await thread.load();
    expect(thread.getState().peerReadThrough).toBe(1);
    // An ended conversation says nothing.
    server.peerLeaves();
    await thread.refresh();
    expect(thread.getState().peerReadThrough).toBeUndefined();
  });

  it('catches up from its cursor and keeps messages in order, ignoring a repeated refresh', async () => {
    const { server, thread } = setup();
    server.peerSays('before');
    await thread.load();
    server.peerSays('after one');
    server.peerSays('after two');
    await Promise.all([thread.refresh(), thread.refresh(), thread.refresh()]);
    expect(thread.getState().messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
    await thread.refresh();
    expect(thread.getState().messages).toHaveLength(3);
    expect(thread.getState().offline).toBe(false);
  });

  it('replaces a message by its tombstone without moving it', async () => {
    const { server, thread } = setup();
    server.peerSays('keep');
    server.peerSays('remove me');
    await thread.load();
    server.tombstone(2);
    await thread.refresh();
    expect(thread.getState().messages.map((message) => [message.sequence, message.status])).toEqual([
      [1, 'available'],
      [2, 'unavailable'],
    ]);
    expect(JSON.stringify(thread.getState().messages)).not.toContain('remove me');
  });

  it('pages older history in front without duplicates', async () => {
    const { server, thread } = setup();
    for (let index = 1; index <= 70; index++) server.peerSays(`m${String(index)}`);
    await thread.load();
    expect(thread.getState().messages).toHaveLength(30);
    expect(thread.getState().hasOlder).toBe(true);
    await thread.loadOlder();
    await thread.loadOlder();
    const sequences = thread.getState().messages.map((message) => message.sequence);
    expect(sequences).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
    expect(thread.getState().hasOlder).toBe(false);
  });

  it('sends once, shows the bubble until it arrives in order, and reads it back', async () => {
    const { server, thread } = setup();
    await thread.load();
    await thread.send(text('hello'));
    expect(thread.getState().outgoing).toEqual([]);
    expect(thread.getState().messages.map((message) => message.sequence)).toEqual([1]);
    expect(server.storedTexts()).toEqual(['hello']);
  });

  it('retries an unknown outcome with the same command, so a lost answer never sends twice', async () => {
    const { server, thread } = setup();
    await thread.load();
    server.failNext('/v1/social/conversations/send', 'lost_response');
    await thread.send(text('did it arrive?'));
    const [pending] = thread.getState().outgoing;
    expect(pending?.status).toBe('unconfirmed');
    expect(server.storedTexts()).toEqual(['did it arrive?']);
    await thread.retry(pending!.commandId);
    expect(thread.getState().outgoing).toEqual([]);
    expect(server.storedTexts()).toEqual(['did it arrive?']);
    const sends = server.requests.filter((request) => request.path.endsWith('/conversations/send'));
    expect(new Set(sends.map((request) => request.body['commandId'])).size).toBe(1);
    expect(thread.getState().messages).toHaveLength(1);
  });

  it('keeps a refused message as one dismissable bubble and reads again to learn why', async () => {
    const { server, thread } = setup();
    await thread.load();
    server.failNext('/v1/social/conversations/send', 'unavailable');
    await thread.send(text('no'));
    expect(thread.getState().outgoing[0]?.status).toBe('not_sent');
    thread.dismiss(thread.getState().outgoing[0]!.commandId);
    expect(thread.getState().outgoing).toEqual([]);
  });

  it('sends a reply naming its original, keeps the quote, and a retry names the same original', async () => {
    const { server, thread } = setup();
    server.peerSays('who is on part 2?');
    await thread.load();
    const original = thread.getState().messages[0]!.messageId;
    server.failNext('/v1/social/conversations/send', 'lost_response');
    await thread.send(text('part 2 abhi start kiya'), original);
    const [pending] = thread.getState().outgoing;
    expect(pending).toMatchObject({ status: 'unconfirmed', replyTo: original });
    await thread.retry(pending!.commandId);
    const sends = server.requests.filter((request) => request.path.endsWith('/conversations/send'));
    expect(sends.map((request) => request.body['replyTo'])).toEqual([original, original]);
    expect(new Set(sends.map((request) => request.body['commandId'])).size).toBe(1);
    expect(thread.getState().messages[1]).toMatchObject({
      replyTo: { messageId: original, sequence: 1, original: { status: 'available', preview: 'who is on part 2?' } },
    });
  });

  it('sends a refused reply again as a plain message, once, and only a refused reply', async () => {
    const { server, thread } = setup();
    server.peerSays('soon removed');
    await thread.load();
    const original = thread.getState().messages[0]!.messageId;
    server.tombstone(1);
    // The reader has not caught up: the reply names a message that is gone, which the server refuses for good.
    await thread.send(text('part 2 abhi start kiya'), original);
    const [refused] = thread.getState().outgoing;
    expect(refused).toMatchObject({ status: 'not_sent', replyTo: original });
    await thread.sendWithoutQuote(refused!.commandId);
    await thread.sendWithoutQuote(refused!.commandId);
    expect(server.storedTexts()).toEqual([null, 'part 2 abhi start kiya']);
    const sends = server.requests.filter((request) => request.path.endsWith('/conversations/send'));
    expect(sends.map((request) => request.body['replyTo'])).toEqual([original, undefined]);
    expect(new Set(sends.map((request) => request.body['commandId'])).size).toBe(2);
    expect(thread.getState().outgoing).toEqual([]);
  });

  it('does not resend a plain message or one that is still unconfirmed without its quote', async () => {
    const { server, thread } = setup();
    await thread.load();
    server.failNext('/v1/social/conversations/send', 'unavailable');
    await thread.send(text('plain'));
    const [plain] = thread.getState().outgoing;
    expect(plain?.status).toBe('not_sent');
    await thread.sendWithoutQuote(plain!.commandId);
    expect(thread.getState().outgoing).toHaveLength(1);
    expect(server.sendsReceived()).toBe(1);
  });

  it('reacts and un-reacts, reading the message back with its count; a person reacting is mine, a peer is not', async () => {
    const { server, thread } = setup();
    server.peerSays('the far side bulges too');
    await thread.load();
    const [message] = thread.getState().messages;
    await thread.react(message!.messageId, 'heart', true);
    server.peerReacts(1, 'heart');
    await thread.refresh();
    expect(thread.getState().messages[0]).toMatchObject({
      reactions: [{ kind: 'heart', mine: true, people: [{ personId: me.personId }, { personId: peer.personId }] }],
    });
    await thread.react(message!.messageId, 'heart', false);
    expect(thread.getState().messages[0]).toMatchObject({ reactions: [{ kind: 'heart', mine: false }] });
    await thread.react(message!.messageId, 'heart', false);
    expect(server.reactionsOn(1)).toEqual([{ kind: 'heart', by: 'peer' }]);
  });

  it('reads again, and shows nothing wrong, when a reaction is refused', async () => {
    const { server, thread } = setup();
    server.peerSays('hello');
    await thread.load();
    server.failNext('/v1/social/conversations/react', 'unavailable');
    await thread.react(thread.getState().messages[0]!.messageId, 'spark', true);
    expect(server.reactionsOn(1)).toEqual([]);
    await vi.waitFor(() =>
      expect(server.requests.filter((request) => request.path.endsWith('/conversations/read'))).toHaveLength(2),
    );
  });

  it('shows the thread as unavailable, saying nothing more, when the server refuses the read', async () => {
    const { server, thread } = setup();
    server.failNext('/v1/social/conversations/read', 'unavailable');
    await thread.load();
    expect(thread.getState().phase).toBe('unavailable');
    expect(thread.getState().messages).toEqual([]);
  });

  it('fails the first load softly and recovers on the next try; later failures only mark it offline', async () => {
    const { server, thread } = setup();
    server.failNext('/v1/social/conversations/read', 'network');
    await thread.load();
    expect(thread.getState()).toMatchObject({ phase: 'failed', offline: true });
    await thread.load();
    expect(thread.getState().phase).toBe('ready');
    server.failNext('/v1/social/conversations/changes', 'network');
    await thread.refresh();
    expect(thread.getState()).toMatchObject({ phase: 'ready', offline: true });
    await thread.refresh();
    expect(thread.getState().offline).toBe(false);
  });

  it('learns that the other person left from the next catch-up, and keeps the history', async () => {
    const { server, thread } = setup();
    server.peerSays('goodbye');
    await thread.load();
    server.peerLeaves();
    await thread.refresh();
    expect(thread.getState()).toMatchObject({ ended: true, phase: 'ready' });
    expect(thread.getState().messages).toHaveLength(1);
  });

  it('marks the newest message read only while the thread is on screen', async () => {
    const { server, thread } = setup();
    server.peerSays('hi');
    await thread.load();
    const marks = () => server.requests.filter((request) => request.path.endsWith('/mark-read'));
    expect(marks()).toHaveLength(0);
    thread.setActive(true);
    await new Promise((resolve) => setTimeout(resolve));
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.body['throughSequence']).toBe(1);
    thread.setActive(true);
    await new Promise((resolve) => setTimeout(resolve));
    expect(marks()).toHaveLength(1);
  });

  it('mutes, and leaves into an unavailable thread', async () => {
    const { thread } = setup();
    await thread.load();
    expect(await thread.mute(true)).toBe(true);
    expect(thread.getState().muted).toBe(true);
    expect(await thread.leave()).toBe(true);
    expect(thread.getState().phase).toBe('unavailable');
  });

  it('drops everything quietly once its account scope has ended', async () => {
    const { server, thread } = setup();
    await thread.load();
    const before = thread.getState();
    server.scope.end();
    server.peerSays('late');
    await thread.refresh();
    await thread.send(text('late send'));
    expect(thread.getState()).toBe(before);
  });
});

describe('conversation thread after the other account is deleted', () => {
  it('rereads the thread when it ends, so the other person shows as "Deleted account"', async () => {
    const { server, thread } = setup();
    server.peerSays('goodbye');
    await thread.load();
    expect(thread.getState().peer).toEqual(peer);
    server.peerDeletes();
    await thread.refresh();
    expect(thread.getState()).toMatchObject({ ended: true, peer: { displayName: 'Deleted account' } });
    expect(thread.getState().messages).toHaveLength(1);
  });
});

describe('mergeMessages', () => {
  const messageId = '0199a000-0000-7000-8000-0000000000aa';
  const available = (sequence: number, body: string): ConversationMessage => ({
    messageId,
    sequence,
    status: 'available',
    author: peer,
    recordedAt: '2026-10-24T08:00:00.000Z',
    body: { kind: 'text', text: body },
  });
  const tombstone = (sequence: number): ConversationMessage => ({ messageId, sequence, status: 'unavailable' });

  it('puts a tombstone in place of the message it replaces', () => {
    expect(mergeMessages([available(1, 'delete me')], [tombstone(1)])).toEqual([tombstone(1)]);
  });

  it('never brings deleted text back from an older page that was fetched before the deletion', () => {
    expect(mergeMessages([tombstone(1), available(2, 'stays')], [available(1, 'delete me')])).toEqual([
      tombstone(1),
      available(2, 'stays'),
    ]);
  });

  it('orders by sequence and keeps one copy of a repeated message', () => {
    const merged = mergeMessages([available(3, 'c'), available(1, 'a')], [available(2, 'b'), available(3, 'c')]);
    expect(merged.map((message) => message.sequence)).toEqual([1, 2, 3]);
  });
});
