import { describe, expect, it } from 'vitest';
import type { ChallengeCard, DirectConversationRef } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createConversationThread } from './conversation-thread';
import { createShareSession } from './share-session';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const conversation: DirectConversationRef = { conversationId: id(20), membershipId: id(21), membershipRevision: 1 };
const peer = { kind: 'person' as const, personId: id(11), handle: 'fixture.ravi', displayName: 'Ravi fixture' };
const target = { assetId: id(40), assetRevision: 1 };
const scopeEnvelope = { accountId: id(1), privacyEpoch: 1 };
const offline = () => new TypeError('network');

const open: ChallengeCard = {
  stage: 'open',
  stopId: 'tides-call',
  prompt: 'CI fixture question: when are tides biggest?',
  options: ['CI full and new moon', 'CI half moon', 'CI always the same'],
};

type Recording = 'collecting' | 'paused';

/**
 * A labelled fake of the Talk calls a challenge uses: the conversation read, the changes feed, send and the pick lock.
 * It keeps one challenge card for the person and answers the stage that follows their own pick. Never product data.
 */
function fakeTalk(options: { recording?: Recording } = {}) {
  const requests: { name: string; input: Record<string, unknown> }[] = [];
  const state: { pick?: number; stale: number; failNext: Error[]; recording: Recording; refreshed: number } = {
    stale: 0,
    failNext: [],
    recording: options.recording ?? 'collecting',
    refreshed: 0,
  };
  const card = (): ChallengeCard =>
    state.pick === undefined ? open : { ...open, stage: 'locked', option: state.pick };
  const message = () => ({
    messageId: id(1001),
    sequence: 1,
    status: 'available' as const,
    author: peer,
    recordedAt: '2026-10-24T08:00:00.000Z',
    body: {
      kind: 'content' as const,
      content: {
        status: 'available' as const,
        target,
        metadata: { kind: 'scroll' as const, title: 'CI Scroll', summary: 'CI.', language: 'en' },
      },
      challenge: card(),
    },
  });
  const conversations = {
    read: (input: Record<string, unknown>) =>
      Promise.resolve({
        version: 'direct-conversation.v1',
        scope: scopeEnvelope,
        readId: input['readId'],
        status: 'ready',
        conversation,
        peer,
        own: { readThroughSequence: 1, muted: false },
        latestMessageSequence: 1,
        messages: [message()],
        limit: 30,
        history: { kind: 'end' },
        catchUpCursor: `kcc1_${'A'.repeat(25)}1`,
      }),
    changes: (input: Record<string, unknown>) =>
      Promise.resolve({
        version: 'direct-conversation.v1',
        scope: scopeEnvelope,
        readId: input['readId'],
        status: 'ready',
        conversation,
        limit: 50,
        requestCursor: input['cursor'],
        fromChangeSequence: 1,
        throughChangeSequence: 2,
        changes: [{ changeSequence: 2, message: message() }],
        continuation: { kind: 'caught_up', cursor: `kcc1_${'A'.repeat(25)}2` },
      }),
    markRead: () => Promise.resolve({ acceptedThroughSequence: 1 }),
    lockChallenge: (input: Record<string, unknown>) => {
      requests.push({ name: 'lockChallenge', input });
      const failure = state.failNext.shift();
      if (failure !== undefined) return Promise.reject(failure);
      if (state.stale > 0) {
        state.stale -= 1;
        return Promise.resolve({ recorded: false, reason: 'recording_generation_stale', currentGeneration: 3 });
      }
      if (state.recording === 'paused')
        return Promise.resolve({ recorded: false, reason: 'recording_paused', currentGeneration: 2 });
      state.pick ??= input['option'] as number;
      return Promise.resolve({ recorded: true, result: 'locked' });
    },
    send: (input: Record<string, unknown>) => {
      requests.push({ name: 'send', input });
      return Promise.resolve({ messageId: id(1002), messageSequence: 2 });
    },
    start: () => Promise.resolve({ conversation }),
    inbox: () => Promise.resolve({ status: 'ready', items: [] }),
  };
  const friendPages = {
    friends: () => Promise.resolve({ items: [{ state: 'friends', peer, pairRevision: 3 }], next: undefined }),
  };
  const scope = {
    active: true,
    api: { conversations, friendPages },
    onEnd: () => () => undefined,
    recording: {
      getState: () => ({ policy: { on: state.recording === 'collecting', generation: 1 } }),
      generation: () => Promise.resolve(state.recording === 'collecting' ? 1 : 2),
      refresh: () => {
        state.refreshed += 1;
        return Promise.resolve(true);
      },
    },
  } as unknown as AccountScope;
  return { scope, requests, state, locks: () => requests.filter((request) => request.name === 'lockChallenge') };
}

let counter = 1000;
const newId = () => id(counter++);

describe('a challenge card in a conversation, on the client', () => {
  it('locks a pick with the message, the option and the recording generation, then reads what the server holds', async () => {
    const server = fakeTalk();
    const thread = createConversationThread({ scope: server.scope, conversation, newId });
    await thread.load();
    await thread.lockChallenge(id(1001), 1);
    const [sent] = server.locks();
    expect(Object.keys(sent!.input).toSorted()).toEqual([
      'conversation',
      'messageId',
      'option',
      'recordingGeneration',
      'version',
    ]);
    expect(sent!.input).toMatchObject({ messageId: id(1001), option: 1, recordingGeneration: 1 });
    expect(thread.getState()).toMatchObject({ lockingChallenge: undefined, challengeNotice: undefined });
    const shown = thread.getState().messages[0];
    expect(
      shown?.status === 'available' && shown.body.kind === 'content' ? shown.body.challenge : undefined,
    ).toMatchObject({
      stage: 'locked',
      option: 1,
    });
  });

  it('sends nothing while recording is paused, and says so on that card', async () => {
    const server = fakeTalk({ recording: 'paused' });
    const thread = createConversationThread({ scope: server.scope, conversation, newId });
    await thread.load();
    await thread.lockChallenge(id(1001), 0);
    expect(server.locks()).toEqual([]);
    expect(thread.getState().challengeNotice).toEqual({ messageId: id(1001), reason: 'paused' });
  });

  it('reads the policy again and sends the same pick once when the generation was stale', async () => {
    const server = fakeTalk();
    server.state.stale = 1;
    const thread = createConversationThread({ scope: server.scope, conversation, newId });
    await thread.load();
    await thread.lockChallenge(id(1001), 2);
    expect(server.state.refreshed).toBe(1);
    expect(server.locks().map((request) => request.input['option'])).toEqual([2, 2]);
    expect(thread.getState().challengeNotice).toBeUndefined();
  });

  it('says a pick did not get through when no answer came, so the person may press again', async () => {
    const server = fakeTalk();
    server.state.failNext.push(offline());
    const thread = createConversationThread({ scope: server.scope, conversation, newId });
    await thread.load();
    await thread.lockChallenge(id(1001), 0);
    expect(thread.getState().challengeNotice).toEqual({ messageId: id(1001), reason: 'failed' });
    await thread.lockChallenge(id(1001), 0);
    expect(thread.getState().challengeNotice).toBeUndefined();
  });
});

describe('challenging a friend from a Scroll', () => {
  async function challengeSession(server: ReturnType<typeof fakeTalk>) {
    const session = createShareSession({
      scope: server.scope,
      target,
      challenge: { stopId: 'tides-call' },
      origin: 'https://app.fixture.test',
      newId,
      copyText: () => Promise.resolve(),
    });
    await session.loadTargets();
    session.select(peer.personId);
    return session;
  }

  it('sends the card as a challenge for the stop, with no pick in it, then locks the sender’s own pick', async () => {
    const server = fakeTalk();
    const session = await challengeSession(server);
    session.setPick(1);
    await session.send();
    const send = server.requests.find((request) => request.name === 'send');
    expect(send!.input['body']).toEqual({ kind: 'content', target, challenge: { stopId: 'tides-call' } });
    expect(server.locks().map((request) => request.input)).toMatchObject([{ messageId: id(1002), option: 1 }]);
    expect(session.getState().send).toMatchObject({ status: 'sent', pick: 'kept' });
  });

  it('is still sent when recording is paused, and says the pick was not saved', async () => {
    const server = fakeTalk({ recording: 'paused' });
    const session = await challengeSession(server);
    session.setPick(0);
    await session.send();
    expect(server.locks()).toEqual([]);
    expect(session.getState().send).toMatchObject({ status: 'sent', pick: 'paused' });
  });

  it('is still sent when the pick does not get through, and says so', async () => {
    const server = fakeTalk();
    server.state.failNext.push(offline());
    const session = await challengeSession(server);
    session.setPick(2);
    await session.send();
    expect(session.getState().send).toMatchObject({ status: 'sent', pick: 'not_kept' });
  });

  it('asks nothing of a pick for an ordinary share', async () => {
    const server = fakeTalk();
    const session = createShareSession({
      scope: server.scope,
      target,
      origin: 'https://app.fixture.test',
      newId,
      copyText: () => Promise.resolve(),
    });
    await session.loadTargets();
    session.select(peer.personId);
    await session.send();
    expect(server.locks()).toEqual([]);
    expect(session.getState().send).toMatchObject({ status: 'sent' });
    expect(session.getState().send).not.toHaveProperty('pick');
  });
});
