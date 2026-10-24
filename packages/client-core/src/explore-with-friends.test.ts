import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { MAX_THREAD_FRIENDS, problemDetails } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createExploreWithFriends } from './explore-with-friends';
import { describeThreadMessage, threadRowView } from './thread-inbox';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.friend${String(n)}`,
  displayName: `Friend ${String(n)}`,
});
const root = { assetId: id(500), assetRevision: 1 };
const thread = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
let counter = 2000;
const newId = () => id(counter++);

function scopeOf(options: { friends: number; create: (input: { commandId: string }) => Promise<unknown> }) {
  const created: { commandId: string; friendPersonIds: string[]; name?: string }[] = [];
  const scope = {
    active: true,
    api: {
      conversations: { inbox: () => Promise.resolve({ status: 'ready', items: [{ peer: person(3), conversation: {} }] }) },
      friendPages: {
        friends: () =>
          Promise.resolve({
            items: Array.from({ length: options.friends }, (_, index) => ({
              state: 'friends',
              peer: person(index + 1),
            })),
            next: undefined,
          }),
      },
      threads: {
        create: (input: { commandId: string; friendPersonIds: string[]; name?: string }) => {
          created.push(input);
          return options.create(input);
        },
      },
    },
  } as unknown as AccountScope;
  return { scope, created };
}

describe('Explore with friends', () => {
  it('lists friends with the people the person talks to first', async () => {
    const { scope } = scopeOf({ friends: 4, create: () => Promise.resolve({ thread }) });
    const session = createExploreWithFriends({ scope, root, newId });
    await session.loadFriends();
    expect(session.getState().friends.items.map((friend) => friend.personId)).toEqual([id(3), id(1), id(2), id(4)]);
  });

  it('chooses people up to the limit and creates one thread with the chosen names', async () => {
    const { scope, created } = scopeOf({ friends: 10, create: () => Promise.resolve({ thread }) });
    const session = createExploreWithFriends({ scope, root, newId });
    await session.loadFriends();
    expect(session.getState().selected).toEqual([]);
    await session.create();
    expect(created).toEqual([]);
    for (let n = 1; n <= 10; n++) session.toggle(id(n));
    expect(session.getState().selected).toHaveLength(MAX_THREAD_FRIENDS);
    session.toggle(id(1));
    expect(session.getState().selected).not.toContain(id(1));
    session.setName('  Black holes  ');
    await session.create();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Black holes', friendPersonIds: session.getState().selected });
    expect(session.getState().create).toEqual({ status: 'created', thread });
    // Nothing more can be changed or sent once created.
    session.toggle(id(1));
    await session.create();
    expect(created).toHaveLength(1);
  });

  it('retries the identical command after a lost answer, and a new choice is a new command', async () => {
    let call = 0;
    const { scope, created } = scopeOf({
      friends: 3,
      create: () => (++call === 1 ? Promise.reject(new Error('network')) : Promise.resolve({ thread })),
    });
    const session = createExploreWithFriends({ scope, root, newId });
    await session.loadFriends();
    session.toggle(id(1));
    session.toggle(id(2));
    await session.create();
    expect(session.getState().create.status).toBe('unconfirmed');
    // The choice is locked while the outcome is unknown.
    session.toggle(id(3));
    expect(session.getState().selected).toEqual([id(1), id(2)]);
    await session.create();
    expect(created[0]?.commandId).toBe(created[1]?.commandId);
    expect(session.getState().create.status).toBe('created');
  });

  it('says nothing about who when the server refuses, and lets the person choose again', async () => {
    const refused = new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });
    const { scope, created } = scopeOf({ friends: 2, create: () => Promise.reject(refused) });
    const session = createExploreWithFriends({ scope, root, newId });
    await session.loadFriends();
    session.toggle(id(1));
    await session.create();
    expect(session.getState().create.status).toBe('unavailable');
    session.toggle(id(2));
    await session.create();
    expect(created[0]?.commandId).not.toBe(created[1]?.commandId);
  });
});

describe('Talk rows for threads', () => {
  const summary = (patch: Record<string, unknown>) =>
    ({
      thread,
      root: {
        status: 'available',
        target: root,
        metadata: { kind: 'reel', title: 'The edge', summary: '', language: 'en' },
      },
      state: 'joined',
      people: [person(1)],
      latestMessageSequence: 0,
      own: { readThroughSequence: 0, muted: false },
      lastActivityAt: '2026-10-24T08:00:00.000Z',
      ...patch,
    }) as Parameters<typeof threadRowView>[0];
  const text = (author: ReturnType<typeof person>, value: string) =>
    ({
      messageId: id(900),
      sequence: 1,
      status: 'available',
      author,
      recordedAt: '2026-10-24T08:00:00.000Z',
      body: { kind: 'text', text: value },
    }) as const;

  it('shows an invitation in words, as unread, with nothing of the conversation', () => {
    expect(threadRowView(summary({ state: 'invited' }))).toMatchObject({
      title: 'The edge',
      subtitle: 'Friend 1 invited you to explore a Reel',
      invited: true,
      unread: true,
    });
  });

  it('shows the thread name, the last message and unread only for messages that are not the person’s own', () => {
    const theirs = summary({ name: 'Black holes', latestMessageSequence: 1, lastMessage: text(person(1), 'look') });
    expect(threadRowView(theirs, id(99))).toMatchObject({
      title: 'Black holes',
      subtitle: 'Friend 1: look',
      unread: true,
    });
    const mine = summary({ latestMessageSequence: 1, lastMessage: text(person(99), 'hello') });
    expect(threadRowView(mine, id(99))).toMatchObject({ subtitle: 'You: hello', unread: false });
  });

  it('describes a snippet as a moment, a passage or a part', () => {
    const snippet = (body: Record<string, unknown>) =>
      ({ ...text(person(1), ''), body: { kind: 'snippet', snippet: body } }) as Parameters<
        typeof describeThreadMessage
      >[0];
    const content = { status: 'unavailable', target: root };
    expect(
      describeThreadMessage(snippet({ kind: 'reel_range', startMs: 18_000, endMs: 31_000, content }), id(99)),
    ).toBe('Friend 1 shared a moment of a Reel · 0:18–0:31');
    expect(describeThreadMessage(snippet({ kind: 'scroll_passage', blockId: 'a', content }), id(99))).toBe(
      'Friend 1 shared a passage of a Scroll',
    );
    expect(
      describeThreadMessage(
        snippet({ kind: 'scroll_block', blockId: 'a', blockType: 'simulation', settings: { included: true }, content }),
        id(99),
      ),
    ).toBe('Friend 1 shared a part of a Scroll, as they set it');
    expect(describeThreadMessage({ messageId: id(1), sequence: 2, status: 'unavailable' }, id(99))).toBe(
      'Message removed',
    );
  });
});
