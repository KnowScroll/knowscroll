import type { FriendsFailure, FriendsState } from '@knowscroll/client-core';
import { readAllFriends, type FriendsPager } from './read-friends';

type Item = { personId: string; handle: string; displayName: string; state?: string };
type Reply = { items: Item[]; next?: { token: string } } | FriendsFailure;

const item = (n: number, state = 'friends'): Item => ({
  personId: `p${n}`,
  handle: `h${n}`,
  displayName: `Name ${n}`,
  state,
});

/** A pager that answers from a script, one reply for each call to `selectFilter` or `nextPage`, in order. */
function pager(script: readonly Reply[], status: 'active' | 'ended' = 'active'): FriendsPager & { calls: string[] } {
  let at = -1;
  let state = { status, roster: { status: 'idle' } } as unknown as FriendsState;
  const calls: string[] = [];
  const play = (): void => {
    at += 1;
    const reply = script[at]!;
    state =
      typeof reply === 'string'
        ? ({ status, roster: { status: 'unavailable', reason: reply } } as unknown as FriendsState)
        : ({
            status,
            roster: {
              status: 'ready',
              data: {
                items: reply.items.map((entry) => ({
                  state: entry.state ?? 'friends',
                  peer: {
                    kind: 'person',
                    personId: entry.personId,
                    handle: entry.handle,
                    displayName: entry.displayName,
                  },
                  pairRevision: 1,
                  availability: { state: 'online' },
                })),
                ...(reply.next === undefined ? {} : { next: reply.next }),
              },
            },
          } as unknown as FriendsState);
  };
  return {
    calls,
    getState: () => state,
    selectFilter: () => {
      calls.push('select');
      play();
      return Promise.resolve();
    },
    nextPage: () => {
      calls.push('next');
      play();
      return Promise.resolve();
    },
  };
}

describe('reading every friend', () => {
  it('reads one page and stops when the page has no continuation', async () => {
    const read = await readAllFriends(pager([{ items: [item(1), item(2)] }]));
    expect(read).toEqual({
      status: 'ready',
      complete: true,
      friends: [
        { personId: 'p1', handle: 'h1', name: 'Name 1' },
        { personId: 'p2', handle: 'h2', name: 'Name 2' },
      ],
    });
  });

  it('accumulates the pages, in order, and keeps only person id, handle and name (no presence)', async () => {
    const read = await readAllFriends(
      pager([
        { items: [item(1)], next: { token: 'a' } },
        { items: [item(2)], next: { token: 'b' } },
        { items: [item(3)] },
      ]),
    );
    expect(read.status).toBe('ready');
    expect(read.friends.map((friend) => friend.handle)).toEqual(['h1', 'h2', 'h3']);
    for (const friend of read.friends) expect(Object.keys(friend).sort()).toEqual(['handle', 'name', 'personId']);
  });

  it('treats an empty page that has a continuation as progress, and only the absence of one as the end', async () => {
    const read = await readAllFriends(pager([{ items: [], next: { token: 'a' } }, { items: [item(1)] }]));
    expect(read.friends).toHaveLength(1);
    expect(read.status === 'ready' && read.complete).toBe(true);
  });

  it('skips a row that is not a friend, and a friend it has already', async () => {
    const read = await readAllFriends(pager([{ items: [item(1), item(2, 'blocked'), item(1)] }]));
    expect(read.friends.map((friend) => friend.handle)).toEqual(['h1']);
  });

  it('stops at the page limit with the friends so far, and says the list is not all of them', async () => {
    const script: Reply[] = Array.from({ length: 5 }, (_, n) => ({ items: [item(n)], next: { token: `t${n}` } }));
    const read = await readAllFriends(pager(script), { maxPages: 3 });
    expect(read.friends).toHaveLength(3);
    expect(read).toMatchObject({ status: 'ready', complete: false });
  });

  it('stops going on when the time is up', async () => {
    let clock = 0;
    const read = await readAllFriends(pager([{ items: [item(1)], next: { token: 'a' } }, { items: [item(2)] }]), {
      budgetMs: 50,
      now: () => (clock += 60),
    });
    expect(read).toMatchObject({ status: 'ready', complete: false });
    expect(read.friends).toHaveLength(1);
  });

  it('starts again from page one when the roster changed under a later page, and gives the new list', async () => {
    const source = pager([
      { items: [item(1)], next: { token: 'a' } },
      'refresh_required',
      { items: [item(1), item(9)] },
    ]);
    const read = await readAllFriends(source);
    expect(source.calls).toEqual(['select', 'next', 'select']);
    expect(read.friends.map((friend) => friend.handle)).toEqual(['h1', 'h9']);
    expect(read.status === 'ready' && read.complete).toBe(true);
  });

  it('gives up after two restarts and returns what it has as a failure, never as all of them', async () => {
    const changed: Reply[] = [{ items: [item(1)], next: { token: 'a' } }, 'refresh_required'];
    const source = pager([...changed, ...changed, ...changed]);
    const read = await readAllFriends(source, { restarts: 2 });
    expect(source.calls.filter((call) => call === 'select')).toHaveLength(3);
    expect(read).toMatchObject({ status: 'failed', complete: false });
  });

  it('reports a lost connection as offline, keeping the friends read, and a refused first page as failed', async () => {
    expect(await readAllFriends(pager([{ items: [item(1)], next: { token: 'a' } }, 'network']))).toMatchObject({
      status: 'offline',
      complete: false,
      friends: [{ handle: 'h1' }],
    });
    expect(await readAllFriends(pager(['network']))).toMatchObject({ status: 'offline', friends: [] });
    expect(await readAllFriends(pager(['unavailable']))).toMatchObject({ status: 'failed', friends: [] });
    expect(await readAllFriends(pager(['authority']))).toMatchObject({ status: 'failed' });
  });

  it('returns at once, as a failure, when the session ended or the caller no longer wants the answer', async () => {
    expect(await readAllFriends(pager([{ items: [item(1)] }], 'ended'))).toMatchObject({
      status: 'failed',
      friends: [],
    });
    expect(await readAllFriends(pager([{ items: [item(1)] }]), { wanted: () => false })).toMatchObject({
      status: 'failed',
      friends: [],
    });
  });
});
