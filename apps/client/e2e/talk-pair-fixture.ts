import type { Page } from '@playwright/test';
import { id } from './encounter-fixture';

/**
 * One direct conversation between two labelled people, served over HTTP fixtures to two browser pages at
 * once (no backend). What one page sends the other reads, so replies, reactions and the changes feed can be
 * exercised from both sides. It keeps the real server's rules that the client depends on: gapless sequences,
 * a fresh change number for a changed reaction, one reaction per person and kind, a reply only to a
 * message of this conversation, per-reader `mine`, and SEEN (D-066): each person's read position moves only by
 * their own mark-read, and the other person is told how far it has moved only while both people's switches are on.
 * Authored names, never product data.
 */
export type Who = 'asha' | 'ravi';

const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(10 + n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: `${name} fixture`,
});
const people = { asha: person(0, 'Asha'), ravi: person(1, 'Ravi') };
const accounts = {
  asha: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'asha@fixture.test' },
  ravi: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'ravi@fixture.test' },
};
const other = (who: Who): Who => (who === 'asha' ? 'ravi' : 'asha');
export const pairConversation = (who: Who) => ({
  conversationId: id(20),
  membershipId: id(who === 'asha' ? 21 : 22),
  membershipRevision: 1,
});
export const pairAddress = (who: Who) => {
  const reference = pairConversation(who);
  return `/conversations/${reference.conversationId}?m=${reference.membershipId}&r=1`;
};

interface Stored {
  sequence: number;
  changeSequence: number;
  messageId: string;
  author: Who;
  recordedAt: string;
  text: string;
  replyTo: number | null;
  reactions: { kind: string; by: Who }[];
}

const KINDS = ['spark', 'mind_blown', 'ha', 'heart', 'question'];
const cursor = (n: number) => `kcc1_${'A'.repeat(25)}${String(n)}`;
const cursorValue = (token: string) => Number(token.replace(/^kcc1_A*/, ''));

export function pairWorld() {
  const messages: Stored[] = [];
  let changes = 0;
  /** How far each person has read: moved by their own mark-read only, whether or not they share it. */
  const readThrough: Record<Who, number> = { asha: 0, ravi: 0 };
  /** Each person's SEEN switch (on by default) and its revision. */
  const sharing: Record<Who, { shared: boolean; revision: number }> = {
    asha: { shared: true, revision: 1 },
    ravi: { shared: true, revision: 1 },
  };
  /** What the server may tell `who` about the other person's reading: only while both share. */
  const peerReadFor = (who: Who) =>
    sharing.asha.shared && sharing.ravi.shared ? { peerRead: { throughSequence: readThrough[other(who)] } } : {};
  const find = (sequence: number) => messages.find((message) => message.sequence === sequence)!;

  const quoteOf = (sequence: number) => {
    const original = find(sequence);
    return {
      messageId: original.messageId,
      sequence,
      original: { status: 'available', author: people[original.author], preview: original.text },
    };
  };
  const view = (message: Stored, viewer: Who) => ({
    messageId: message.messageId,
    sequence: message.sequence,
    status: 'available',
    author: people[message.author],
    recordedAt: message.recordedAt,
    ...(message.replyTo === null ? {} : { replyTo: quoteOf(message.replyTo) }),
    ...(message.reactions.length === 0
      ? {}
      : {
          reactions: KINDS.flatMap((kind) => {
            const by = message.reactions.filter((reaction) => reaction.kind === kind);
            return by.length === 0
              ? []
              : [
                  {
                    kind,
                    mine: by.some((reaction) => reaction.by === viewer),
                    people: by.map((reaction) => people[reaction.by]),
                  },
                ];
          }),
        }),
    body: { kind: 'text', text: message.text },
  });

  const world = {
    messages,
    /** A message by `who`, `minutesAgo` minutes ago, optionally answering the one with this sequence. */
    say(who: Who, text: string, options: { replyTo?: number; minutesAgo?: number } = {}) {
      const sequence = messages.length + 1;
      messages.push({
        sequence,
        changeSequence: ++changes,
        messageId: id(1000 + sequence),
        author: who,
        recordedAt: new Date(Date.now() - (options.minutesAgo ?? 0) * 60_000).toISOString(),
        text,
        replyTo: options.replyTo ?? null,
        reactions: [],
      });
      return sequence;
    },
    react(who: Who, sequence: number, kind: string, present: boolean) {
      const message = find(sequence);
      const held = message.reactions.some((reaction) => reaction.kind === kind && reaction.by === who);
      if (held === present) return false;
      message.reactions = present
        ? [...message.reactions, { kind, by: who }]
        : message.reactions.filter((reaction) => !(reaction.kind === kind && reaction.by === who));
      message.changeSequence = ++changes;
      return true;
    },
    /** Turns a person's own SEEN switch on or off, as their Account page would. */
    setSeen(who: Who, shared: boolean) {
      if (sharing[who].shared !== shared) sharing[who].revision += 1;
      sharing[who].shared = shared;
    },
    /** How far this person has read. */
    readThrough: (who: Who) => readThrough[who],
    /** What the reactions on a message are now, as "who:kind". */
    reactionsOn: (sequence: number) => find(sequence).reactions.map((reaction) => `${reaction.by}:${reaction.kind}`),
    replyOf: (sequence: number) => find(sequence).replyTo,
    /** The answers for the page of `who`: a path and a body in, a response out. */
    handler(who: Who) {
      const scope = { accountId: accounts[who].accountId, privacyEpoch: 1 };
      const direct = { version: 'direct-conversation.v1', scope };
      const receipt = (body: Record<string, unknown>) => ({
        ...direct,
        commandId: body['commandId'],
        recordedAt: new Date().toISOString(),
        replayed: false,
        outcome: 'accepted',
        conversation: pairConversation(who),
      });
      const problem = {
        status: 404,
        json: {
          type: 'https://knowscroll.space/problems/SHARING_UNAVAILABLE',
          title: 'SHARING_UNAVAILABLE',
          status: 404,
          code: 'SHARING_UNAVAILABLE',
        },
      };
      return (path: string, body: Record<string, unknown>): { json: unknown } | { status: number; json: unknown } => {
        const newest = messages.at(-1);
        switch (path) {
          case '/v1/social/conversations/inbox':
            return {
              json: {
                ...direct,
                readId: body['readId'],
                status: 'ready',
                limit: body['limit'],
                viewRevision: 1,
                items:
                  newest === undefined
                    ? []
                    : [
                        {
                          conversation: pairConversation(who),
                          peer: people[other(who)],
                          latestMessageSequence: newest.sequence,
                          own: { readThroughSequence: newest.sequence, muted: false },
                          lastMessage: view({ ...newest, reactions: [], replyTo: null }, who),
                        },
                      ],
                continuation: { kind: 'end' },
              },
            };
          case '/v1/social/conversations/read': {
            const limit = Number(body['limit']);
            const page = messages.slice(-limit);
            return {
              json: {
                ...direct,
                readId: body['readId'],
                status: 'ready',
                conversation: pairConversation(who),
                peer: people[other(who)],
                own: { readThroughSequence: readThrough[who], muted: false },
                ...peerReadFor(who),
                latestMessageSequence: messages.length,
                messages: page.map((message) => view(message, who)),
                limit,
                history:
                  messages.length > limit
                    ? { kind: 'more', cursor: `kch1_${'A'.repeat(25)}${String(messages.length - limit + 1)}` }
                    : { kind: 'end' },
                catchUpCursor: cursor(changes),
              },
            };
          }
          case '/v1/social/conversations/history': {
            const before = Number(String(body['cursor']).replace(/^kch1_A*/, ''));
            const limit = Number(body['limit']);
            const page = messages.filter((message) => message.sequence < before).slice(-limit);
            const first = page[0];
            return {
              json: {
                ...direct,
                readId: body['readId'],
                status: 'ready',
                conversation: pairConversation(who),
                limit,
                requestCursor: body['cursor'],
                messages: page.map((message) => view(message, who)),
                continuation:
                  first !== undefined && first.sequence > 1
                    ? { kind: 'more', cursor: `kch1_${'A'.repeat(25)}${String(first.sequence)}` }
                    : { kind: 'end' },
              },
            };
          }
          case '/v1/social/conversations/changes': {
            const after = cursorValue(String(body['cursor']));
            const page = messages
              .filter((message) => message.changeSequence > after)
              .sort((a, b) => a.changeSequence - b.changeSequence);
            return {
              json: {
                ...direct,
                readId: body['readId'],
                status: 'ready',
                conversation: pairConversation(who),
                limit: body['limit'],
                requestCursor: body['cursor'],
                ...peerReadFor(who),
                fromChangeSequence: after,
                throughChangeSequence: changes,
                changes: page.map((message) => ({
                  changeSequence: message.changeSequence,
                  message: view(message, who),
                })),
                continuation: { kind: 'caught_up', cursor: cursor(changes) },
              },
            };
          }
          case '/v1/social/conversations/send': {
            const sent = body['body'] as { text: string };
            const answered = body['replyTo'];
            const original = answered === undefined ? undefined : messages.find((m) => m.messageId === answered);
            if (answered !== undefined && original === undefined) return problem;
            const sequence = world.say(who, sent.text, original === undefined ? {} : { replyTo: original.sequence });
            return {
              json: {
                ...receipt(body),
                operation: 'message.send',
                messageId: id(1000 + sequence),
                messageSequence: sequence,
                sent: { kind: 'text' },
              },
            };
          }
          case '/v1/social/conversations/react': {
            const target = messages.find((message) => message.messageId === body['messageId']);
            if (target === undefined) return problem;
            const changed = world.react(who, target.sequence, String(body['kind']), Boolean(body['present']));
            return {
              json: {
                ...receipt(body),
                operation: 'message.react',
                messageId: body['messageId'],
                kind: body['kind'],
                present: body['present'],
                changed,
              },
            };
          }
          case '/v1/social/conversations/mark-read': {
            readThrough[who] = Math.max(readThrough[who], Number(body['throughSequence']));
            return {
              json: {
                ...receipt(body),
                operation: 'conversation.read',
                requestedThroughSequence: body['throughSequence'],
                acceptedThroughSequence: readThrough[who],
              },
            };
          }
          case '/v1/social/read-receipts':
            return {
              json: {
                version: 'sharing.v1',
                scope,
                readReceiptsRevision: sharing[who].revision,
                shared: sharing[who].shared,
              },
            };
          case '/v1/social/threads/inbox':
            return {
              json: {
                version: 'content-thread.v1',
                scope,
                readId: body['readId'],
                status: 'ready',
                limit: body['limit'],
                viewRevision: 1,
                items: [],
              },
            };
          case '/v1/privacy/recording/read':
            return {
              json: {
                version: 'recording-policy.v1',
                ...body,
                scope,
                revision: 0,
                policy: { on: true, generation: 1 },
              },
            };
          default:
            return { status: 404, json: {} };
        }
      };
    },
  };
  return world;
}

export type PairWorld = ReturnType<typeof pairWorld>;

/** Signs the page in as `who` and answers its requests from the shared world. */
export async function openPair(page: Page, world: PairWorld, who: Who, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: accounts[who], client: 'web', expiresAt: '2099-10-24T00:00:00.000Z' } }),
  );
  const answer = world.handler(who);
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    return route.fulfill(answer(path, (request.postDataJSON() ?? {}) as Record<string, unknown>));
  });
  await page.goto(pairAddress(who));
}
