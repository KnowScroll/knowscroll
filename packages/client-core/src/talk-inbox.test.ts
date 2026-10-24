import { afterEach, describe, expect, it } from 'vitest';
import { blockFriend, findConversation, readInboxPage } from './talk-inbox';
import { conversation, id, peer, talkServer } from './test-support/talk-fixture';

let counter = 0;
const newId = () => `0199a000-0000-7000-8000-${(++counter + 7000).toString(16).padStart(12, '0')}`;
const servers: ReturnType<typeof talkServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.scope.end();
});
function setup() {
  const server = talkServer();
  servers.push(server);
  return server;
}

describe('Talk inbox reads (labelled in-memory server)', () => {
  it('reads an empty inbox, then a page with the newest conversation', async () => {
    const server = setup();
    expect(await readInboxPage(server.scope, newId)).toEqual({ items: [], next: undefined });
    server.peerSays('hi');
    const page = await readInboxPage(server.scope, newId);
    if (page === 'restart') throw new Error('unexpected restart');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.peer).toEqual(peer);
  });

  it('finds the person’s own reference to a conversation by its ID, and nothing for a stranger’s', async () => {
    const server = setup();
    server.peerSays('hi');
    expect(await findConversation(server.scope, newId, conversation.conversationId)).toEqual(conversation);
    expect(await findConversation(server.scope, newId, id(999))).toBeUndefined();
  });

  it('blocks with the friendship revision it just read, and says no when the server refuses', async () => {
    const server = setup();
    expect(await blockFriend(server.scope, newId, peer.personId)).toBe(true);
    const block = server.requests.find((request) => request.path.endsWith('/friends/block'));
    expect(block?.body).toMatchObject({ peerPersonId: peer.personId, expectedPairRevision: 3 });
    server.failNext('/v1/social/pairs/read', 'network');
    expect(await blockFriend(server.scope, newId, peer.personId)).toBe(false);
  });
});
