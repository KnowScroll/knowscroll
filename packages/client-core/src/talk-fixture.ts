/**
 * A labelled in-memory Talk server for client-core tests: one conversation, a friends roster and
 * share links, answering with contract-shaped JSON through a scope's `fetch`. It keeps the real
 * server's rules that the clients depend on (gapless sequences, idempotent commands, cursors,
 * tombstones that replace a message) and nothing else. Never product data.
 */
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';

export const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'talk@fixture.test' };
export const me = { kind: 'person' as const, personId: id(10), handle: 'fixture.me', displayName: 'Asha fixture' };
export const peer = { kind: 'person' as const, personId: id(11), handle: 'fixture.ravi', displayName: 'Ravi fixture' };
export const conversation = { conversationId: id(20), membershipId: id(21), membershipRevision: 1 };
const scopeEnvelope = { accountId: account.accountId, privacyEpoch: 1 };

type Body = Record<string, unknown>;
interface StoredMessage {
  sequence: number;
  changeSequence: number;
  messageId: string;
  author: typeof me | typeof peer | null;
  text: string | null;
  content: { assetId: string; assetRevision: number } | null;
  note: string | null;
}

export type Failure = 'network' | 'unavailable' | 'server' | 'lost_response';

export function talkServer() {
  const messages: StoredMessage[] = [];
  const commands = new Map<string, unknown>();
  const requests: { path: string; body: Body }[] = [];
  const failures = new Map<string, Failure[]>();
  const shares = new Map<string, { target: unknown; revoked: boolean; createdBy: string }>();
  let changeCounter = 0;
  let ended = false;
  let closed = false;
  let readThrough = 0;
  let muted = false;
  let tokenCounter = 0;
  const token = () => `kssh_${String(++tokenCounter).padStart(43, 'T')}`;

  const view = (message: StoredMessage) =>
    message.author === null
      ? { messageId: message.messageId, sequence: message.sequence, status: 'unavailable' }
      : {
          messageId: message.messageId,
          sequence: message.sequence,
          status: 'available',
          author: message.author,
          recordedAt: '2026-10-24T08:00:00.000Z',
          body:
            message.text !== null
              ? { kind: 'text', text: message.text }
              : {
                  kind: 'content',
                  content: {
                    status: 'available',
                    target: message.content,
                    metadata: {
                      kind: 'reel',
                      title: 'What one answer costs to serve',
                      summary: 'Tokens.',
                      language: 'en',
                    },
                  },
                  ...(message.note === null ? {} : { note: message.note }),
                },
        };
  const cursor = (prefix: string, value: number) => `${prefix}_${'A'.repeat(25)}${String(value)}`;
  const parseCursor = (token: string) => Number(token.replace(/^[a-z0-9]+_A*/, ''));
  const problem = (status: number, code: string) =>
    new Response(JSON.stringify({ type: `https://knowscroll.space/problems/${code}`, title: code, status, code }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });

  function add(
    author: StoredMessage['author'],
    input: { text?: string; content?: StoredMessage['content']; note?: string },
  ) {
    const sequence = messages.length + 1;
    const message: StoredMessage = {
      sequence,
      changeSequence: ++changeCounter,
      messageId: id(1000 + sequence),
      author,
      text: input.text ?? null,
      content: input.content ?? null,
      note: input.note ?? null,
    };
    messages.push(message);
    return message;
  }

  function handle(path: string, body: Body): unknown {
    const base = { version: 'direct-conversation.v1', scope: scopeEnvelope };
    switch (path) {
      case '/v1/social/conversations/read':
        return {
          ...base,
          readId: body['readId'],
          status: 'ready',
          conversation,
          peer,
          own: { readThroughSequence: readThrough, muted },
          ...(ended ? { ended: true } : {}),
          latestMessageSequence: messages.length,
          messages: messages.slice(-Number(body['limit'])).map(view),
          limit: body['limit'],
          history:
            messages.length > Number(body['limit'])
              ? { kind: 'more', cursor: cursor('kch1', messages.length - Number(body['limit']) + 1) }
              : { kind: 'end' },
          catchUpCursor: cursor('kcc1', changeCounter),
        };
      case '/v1/social/conversations/history': {
        const before = parseCursor(String(body['cursor']));
        const page = messages.filter((message) => message.sequence < before).slice(-Number(body['limit']));
        return {
          ...base,
          readId: body['readId'],
          status: 'ready',
          conversation,
          limit: body['limit'],
          requestCursor: body['cursor'],
          messages: page.map(view),
          continuation:
            page[0] && page[0].sequence > 1
              ? { kind: 'more', cursor: cursor('kch1', page[0].sequence) }
              : { kind: 'end' },
        };
      }
      case '/v1/social/conversations/changes': {
        const after = parseCursor(String(body['cursor']));
        if (after > changeCounter)
          return { ...base, readId: body['readId'], status: 'refresh_required', requestCursor: body['cursor'] };
        const page = messages
          .filter((message) => message.changeSequence > after)
          .sort((a, b) => a.changeSequence - b.changeSequence)
          .slice(0, Number(body['limit']));
        const last = page.at(-1)?.changeSequence ?? after;
        return {
          ...base,
          readId: body['readId'],
          status: 'ready',
          conversation,
          limit: body['limit'],
          requestCursor: body['cursor'],
          ...(ended ? { ended: true } : {}),
          fromChangeSequence: after,
          throughChangeSequence: changeCounter,
          changes: page.map((message) => ({ changeSequence: message.changeSequence, message: view(message) })),
          continuation:
            last < changeCounter
              ? { kind: 'more', cursor: cursor('kcc1', last) }
              : { kind: 'caught_up', cursor: cursor('kcc1', changeCounter) },
        };
      }
      case '/v1/social/conversations/send': {
        const key = `send:${String(body['commandId'])}`;
        if (closed) return problem(404, 'SHARING_UNAVAILABLE');
        const replay = commands.get(key);
        if (replay) return { ...(replay as Body), replayed: true };
        const sent = body['body'] as { kind: string; text?: string; target?: StoredMessage['content']; note?: string };
        const message = add(
          me,
          sent.kind === 'text'
            ? { text: sent.text! }
            : { content: sent.target!, ...(sent.note ? { note: sent.note } : {}) },
        );
        const acceptance = {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'message.send',
          conversation,
          messageId: message.messageId,
          messageSequence: message.sequence,
          sent: sent.kind === 'text' ? { kind: 'text' } : { kind: 'content', target: sent.target },
        };
        commands.set(key, acceptance);
        return acceptance;
      }
      case '/v1/social/conversations/mark-read':
        readThrough = Math.max(readThrough, Number(body['throughSequence']));
        return {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'conversation.read',
          conversation,
          requestedThroughSequence: body['throughSequence'],
          acceptedThroughSequence: readThrough,
        };
      case '/v1/social/conversations/mute':
        muted = Boolean(body['muted']);
        return {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'conversation.mute',
          conversation,
          muted,
        };
      case '/v1/social/conversations/leave':
        return {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'conversation.leave',
          conversation,
        };
      case '/v1/social/conversations/inbox':
        return {
          ...base,
          readId: body['readId'],
          status: 'ready',
          limit: body['limit'],
          viewRevision: 1,
          items: messages.length
            ? [
                {
                  conversation,
                  peer,
                  latestMessageSequence: messages.length,
                  own: { readThroughSequence: readThrough, muted },
                  ...(ended ? { ended: true } : {}),
                  lastMessage: view(messages.at(-1)!),
                },
              ]
            : [],
          continuation: { kind: 'end' },
        };
      case '/v1/social/conversations/start': {
        const key = `start:${String(body['commandId'])}`;
        const replay = commands.get(key);
        const acceptance = replay ?? {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'conversation.start',
          conversation,
          peerPersonId: body['peerPersonId'],
        };
        commands.set(key, acceptance);
        return replay ? { ...(replay as Body), replayed: true } : acceptance;
      }
      case '/v1/social/friends/page':
        return {
          version: 'friend-pages.v2',
          requestId: body['requestId'],
          scope: scopeEnvelope,
          filter: 'friends',
          snapshotRevision: 1,
          items: [{ state: 'friends', peer, pairRevision: 3, availability: { state: 'unknown' } }],
        };
      case '/v1/social/pairs/read':
        return {
          version: 'sharing.v1',
          scope: scopeEnvelope,
          status: 'available',
          pair: { state: 'friends', peer, pairRevision: 3, availability: { state: 'unknown' } },
        };
      case '/v1/social/friends/block':
        closed = true;
        return {
          version: 'sharing.v1',
          scope: scopeEnvelope,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'friend.block',
          peerPersonId: body['peerPersonId'],
          basePairRevision: body['expectedPairRevision'],
          acceptedPairRevision: Number(body['expectedPairRevision']) + 1,
        };
      case '/v1/social/content-shares/create': {
        const key = `share:${String(body['commandId'])}`;
        const replay = commands.get(key) as { acceptance: Body } | undefined;
        if (replay)
          return { acceptance: { ...replay.acceptance, replayed: true }, delivery: { status: 'unavailable' } };
        const shareId = id(3000 + shares.size);
        const acceptance = {
          version: 'content-share.v1',
          scope: scopeEnvelope,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          shareId,
          operation: 'content-share.create',
          target: body['target'],
          audience: body['audience'],
          expiresAt: '2026-11-23T08:00:00.000Z',
        };
        shares.set(shareId, { target: body['target'], revoked: false, createdBy: String(body['commandId']) });
        commands.set(key, { acceptance });
        return { acceptance, delivery: { status: 'available', token: token() } };
      }
      case '/v1/social/content-shares/revoke': {
        const share = shares.get(String(body['shareId']));
        if (!share) return problem(404, 'SHARING_UNAVAILABLE');
        share.revoked = true;
        return {
          version: 'content-share.v1',
          scope: scopeEnvelope,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          shareId: body['shareId'],
          operation: 'content-share.revoke',
        };
      }
      case '/v1/social/content-shares/list':
        return {
          version: 'content-share.v1',
          readId: body['readId'],
          scope: scopeEnvelope,
          items: [...shares.entries()]
            .filter(([, share]) => !share.revoked)
            .map(([shareId, share]) => ({
              shareId,
              target: share.target,
              audience: { kind: 'public_metadata' },
              createdAt: '2026-10-24T08:00:00.000Z',
              expiresAt: '2026-11-23T08:00:00.000Z',
              content: {
                status: 'available',
                target: share.target,
                metadata: { kind: 'reel', title: 'What one answer costs to serve', summary: 'Tokens.', language: 'en' },
              },
            })),
        };
      default:
        return problem(404, 'NOT_FOUND');
    }
  }

  const scope: AccountScope = createAccountScope({
    account: { ...account },
    baseUrl: 'https://talk.fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Body;
      requests.push({ path, body });
      const failure = failures.get(path)?.shift();
      if (failure === 'network') throw new TypeError('fetch failed');
      if (failure === 'unavailable') return problem(404, 'SHARING_UNAVAILABLE');
      if (failure === 'server') return problem(500, 'INTERNAL');
      const answer = handle(path, body);
      if (failure === 'lost_response') throw new TypeError('fetch failed');
      return answer instanceof Response ? answer : Response.json(answer);
    },
  });

  return {
    scope,
    requests,
    /** The next request to `path` fails this way. `lost_response` is handled by the server, then the answer is lost. */
    failNext(path: string, ...kinds: Failure[]) {
      failures.set(path, [...(failures.get(path) ?? []), ...kinds]);
    },
    /** The peer writes a message. */
    peerSays: (text: string) => add(peer, { text }),
    /** The server turns a message into a tombstone with a new change number. */
    tombstone(sequence: number) {
      const message = messages.find((candidate) => candidate.sequence === sequence)!;
      message.author = null;
      message.text = null;
      message.content = null;
      message.note = null;
      message.changeSequence = ++changeCounter;
    },
    peerLeaves() {
      ended = true;
      closed = true;
      changeCounter += 0;
    },
    messageCount: () => messages.length,
    sharesOf: () => [...shares.entries()],
    sendsReceived: () => requests.filter((request) => request.path.endsWith('/conversations/send')).length,
    storedTexts: () => messages.map((message) => message.text),
  };
}
