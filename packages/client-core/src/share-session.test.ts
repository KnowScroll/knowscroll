import { afterEach, describe, expect, it } from 'vitest';
import { createShareSession, createSharedLinksSession } from './share-session';
import { conversation, id, peer, talkServer } from './talk-fixture';

let counter = 0;
const newId = () => `0199a000-0000-7000-8000-${(++counter + 9000).toString(16).padStart(12, '0')}`;
const target = { assetId: id(40), assetRevision: 2 };
const servers: ReturnType<typeof talkServer>[] = [];
function setup(copyText: (text: string) => Promise<void> = () => Promise.resolve()) {
  const server = talkServer();
  servers.push(server);
  const session = createShareSession({
    scope: server.scope,
    target,
    origin: 'https://app.fixture.test',
    newId,
    copyText,
  });
  return { server, session };
}
afterEach(() => {
  for (const server of servers.splice(0)) server.scope.end();
});

describe('share sheet session (labelled in-memory server)', () => {
  it('lists friends, putting the people the person already talks with first', async () => {
    const { server, session } = setup();
    await session.loadTargets();
    expect(session.getState().targets).toMatchObject({
      status: 'ready',
      items: [{ person: peer, conversation: undefined, pairRevision: 3 }],
    });
    server.peerSays('hi');
    await session.loadTargets();
    expect(session.getState().targets.items[0]?.conversation).toEqual(conversation);
  });

  it('starts a conversation when there is none, sends the exact revision with a note, and reports sent only after the receipt', async () => {
    const { server, session } = setup();
    await session.loadTargets();
    session.select(peer.personId);
    session.setNote('  This is the bit I meant  ');
    const sending = session.send();
    expect(session.getState().send.status).toBe('sending');
    await sending;
    expect(session.getState().send).toMatchObject({ status: 'sent', conversation });
    const start = server.requests.find((request) => request.path.endsWith('/conversations/start'));
    expect(start?.body).toMatchObject({ peerPersonId: peer.personId, expectedPairRevision: 3 });
    const send = server.requests.find((request) => request.path.endsWith('/conversations/send'));
    expect(send?.body['body']).toEqual({ kind: 'content', target, note: 'This is the bit I meant' });
  });

  it('keeps one command per intent: an unknown outcome retries the identical send and cannot duplicate it', async () => {
    const { server, session } = setup();
    await session.loadTargets();
    session.select(peer.personId);
    server.failNext('/v1/social/conversations/send', 'lost_response');
    await session.send();
    expect(session.getState().send.status).toBe('unconfirmed');
    // The choices are locked while the outcome is unknown.
    session.setNote('changed my mind');
    session.select(undefined);
    expect(session.getState()).toMatchObject({ note: '', selected: peer.personId });
    await session.send();
    expect(session.getState().send.status).toBe('sent');
    expect(server.messageCount()).toBe(1);
    const sends = server.requests.filter((request) => request.path.endsWith('/conversations/send'));
    expect(new Set(sends.map((request) => request.body['commandId'])).size).toBe(1);
    const starts = server.requests.filter((request) => request.path.endsWith('/conversations/start'));
    expect(new Set(starts.map((request) => request.body['commandId'])).size).toBe(1);
  });

  it('shows a refusal as unavailable and lets the person try another friend with fresh commands', async () => {
    const { server, session } = setup();
    await session.loadTargets();
    session.select(peer.personId);
    server.failNext('/v1/social/conversations/start', 'unavailable');
    await session.send();
    expect(session.getState().send.status).toBe('unavailable');
    await session.send();
    expect(session.getState().send.status).toBe('sent');
    const starts = server.requests.filter((request) => request.path.endsWith('/conversations/start'));
    expect(new Set(starts.map((request) => request.body['commandId'])).size).toBe(2);
  });

  it('makes a public link, copies it, and builds it on the app origin', async () => {
    const copied: string[] = [];
    const { server, session } = setup((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await session.copyLink();
    const link = session.getState().link;
    if (link.status !== 'ready') throw new Error('expected a link');
    expect(link.url).toMatch(/^https:\/\/app\.fixture\.test\/s\/kssh_/);
    expect(link.copied).toBe(true);
    expect(copied).toEqual([link.url]);
    const create = server.requests.find((request) => request.path.endsWith('/content-shares/create'));
    expect(create?.body).toMatchObject({ target, audience: { kind: 'public_metadata' } });
  });

  it('still shows the link when the clipboard refuses', async () => {
    const { session } = setup(() => Promise.reject(new Error('denied')));
    await session.copyLink();
    expect(session.getState().link).toMatchObject({ status: 'ready', copied: false });
  });

  it('stops the link it made, and the server stops answering for it', async () => {
    const { server, session } = setup();
    await session.copyLink();
    await session.stopLink();
    expect(session.getState().link.status).toBe('stopped');
    expect(server.sharesOf().every(([, share]) => share.revoked)).toBe(true);
  });

  it('recovers from a lost answer by stopping the unrecoverable link and making a new one', async () => {
    const { server, session } = setup();
    server.failNext('/v1/social/content-shares/create', 'lost_response');
    await session.copyLink();
    expect(session.getState().link.status).toBe('failed');
    await session.copyLink();
    expect(session.getState().link.status).toBe('ready');
    const live = server.sharesOf().filter(([, share]) => !share.revoked);
    expect(live).toHaveLength(1);
  });
});

describe('shared links list', () => {
  it('lists live links and removes one the person stops', async () => {
    const { server, session } = setup();
    await session.copyLink();
    const links = createSharedLinksSession({ scope: server.scope, newId });
    await links.refresh();
    expect(links.getState()).toMatchObject({ status: 'ready', items: [{ audience: { kind: 'public_metadata' } }] });
    await links.stop(links.getState().items[0]!.shareId);
    expect(links.getState().items).toEqual([]);
    expect(links.getState().stopping).toBeUndefined();
  });
});
