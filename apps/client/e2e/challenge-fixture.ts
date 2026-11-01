import type { Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { id } from './encounter-fixture';

/**
 * Challenge a friend over labelled HTTP fixtures (no backend), served to two browser pages at once: what Asha sends, Ravi
 * reads. The fixture keeps the real server's rules for the card (D-245) so the screens can be proved against them: nobody
 * sees the other's pick or the right answer before they have called, both see both once both have, and a pick is stored
 * only while recording is on. The question comes from the labelled CI Scroll `seasons-stage-ci`. Authored names, never
 * product data. The backend is `tests/integration/modules/social-challenges.test.ts`.
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
export const challengeConversation = (who: Who) => ({
  conversationId: id(20),
  membershipId: id(who === 'asha' ? 21 : 22),
  membershipRevision: 1,
});
export const challengeAddress = (who: Who) => {
  const reference = challengeConversation(who);
  return `/conversations/${reference.conversationId}?m=${reference.membershipId}&r=1`;
};

/** The Scroll's Final call, as the document names it: the question the fixture's card asks. */
const document = seasons as unknown as {
  stops: {
    kind: string;
    id: string;
    prompt: string;
    options: string[];
    answer: number;
    explain: string;
    twist: string;
  }[];
};
export const FINAL_CALL = document.stops.find((stop) => stop.kind === 'final_call')!;
export const SCROLL_TARGET = { assetId: id(300), assetRevision: 1 };

interface Stored {
  sequence: number;
  changeSequence: number;
  messageId: string;
  author: Who;
  stopId: string;
}

const cursor = (n: number) => `kcc1_${'A'.repeat(25)}${String(n)}`;
const cursorValue = (token: string) => Number(token.replace(/^kcc1_A*/, ''));

export function challengeWorld(options: { readonly recordingPaused?: Record<Who, boolean> } = {}) {
  const messages: Stored[] = [];
  let changes = 0;
  let started = false;
  const readThrough: Record<Who, number> = { asha: 0, ravi: 0 };
  /** Each person's own pick on the call, the only thing stored about it. */
  const picks: Partial<Record<Who, number>> = {};
  const recordingPaused: Record<Who, boolean> = options.recordingPaused ?? { asha: false, ravi: false };
  /** Every request each person's page made, in order. */
  const requests: { who: Who; path: string; body: Record<string, unknown> }[] = [];
  /** Every card answer each person was given, so a test can look for a pick or an answer that was not due. */
  const cardsShown: { who: Who; json: string }[] = [];

  /** The card `viewer` may see: the same rule as `viewChallenge` on the server. */
  const card = (viewer: Who) => {
    const base = { stopId: FINAL_CALL.id, prompt: FINAL_CALL.prompt, options: FINAL_CALL.options };
    const own = picks[viewer];
    if (own === undefined) return { ...base, stage: 'open' };
    const theirs = picks[other(viewer)];
    if (theirs === undefined) return { ...base, stage: 'locked', option: own };
    const right = own === FINAL_CALL.answer;
    return {
      ...base,
      stage: 'revealed',
      option: own,
      theirs,
      answer: FINAL_CALL.answer,
      explain: FINAL_CALL.explain,
      ...(right ? {} : { twist: FINAL_CALL.twist }),
      right,
      theirsRight: theirs === FINAL_CALL.answer,
    };
  };
  const view = (message: Stored, viewer: Who) => {
    const shown = card(viewer);
    cardsShown.push({ who: viewer, json: JSON.stringify(shown) });
    return {
      messageId: message.messageId,
      sequence: message.sequence,
      status: 'available',
      author: people[message.author],
      recordedAt: new Date().toISOString(),
      body: {
        kind: 'content',
        content: {
          status: 'available',
          target: SCROLL_TARGET,
          metadata: { kind: 'scroll', title: 'CI encounter fixture 1', summary: 'CI challenge', language: 'en' },
        },
        challenge: shown,
      },
    };
  };

  const world = {
    messages,
    requests,
    cardsShown,
    picks: () => ({ ...picks }),
    setRecordingPaused(who: Who, paused: boolean) {
      recordingPaused[who] = paused;
    },
    /** The answers for the page of `who`: a path and a body in, a response out; nothing for a path this world does not own. */
    handler(who: Who) {
      const scope = { accountId: accounts[who].accountId, privacyEpoch: 1 };
      const direct = { version: 'direct-conversation.v1', scope };
      const receipt = (body: Record<string, unknown>) => ({
        ...direct,
        commandId: body['commandId'],
        recordedAt: new Date().toISOString(),
        replayed: false,
        outcome: 'accepted',
        conversation: challengeConversation(who),
      });
      return (
        path: string,
        body: Record<string, unknown>,
      ): { json: unknown } | { status: number; json: unknown } | undefined => {
        requests.push({ who, path, body });
        const newest = messages.at(-1);
        switch (path) {
          case '/v1/social/friends/page':
            return {
              json: {
                version: 'friend-pages.v2',
                requestId: body['requestId'],
                scope,
                filter: 'friends',
                snapshotRevision: 1,
                items: [
                  { state: 'friends', peer: people[other(who)], pairRevision: 3, availability: { state: 'unknown' } },
                ],
              },
            };
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
                          conversation: challengeConversation(who),
                          peer: people[other(who)],
                          latestMessageSequence: newest.sequence,
                          own: { readThroughSequence: newest.sequence, muted: false },
                          lastMessage: view(newest, who),
                        },
                      ],
                continuation: { kind: 'end' },
              },
            };
          case '/v1/social/conversations/start':
            started = true;
            return {
              json: { ...receipt(body), operation: 'conversation.start', peerPersonId: people[other(who)].personId },
            };
          case '/v1/social/conversations/send': {
            const sent = body['body'] as { kind: string; challenge?: { stopId: string } };
            const sequence = messages.length + 1;
            messages.push({
              sequence,
              changeSequence: ++changes,
              messageId: id(1000 + sequence),
              author: who,
              stopId: sent.challenge?.stopId ?? '',
            });
            return {
              json: {
                ...receipt(body),
                operation: 'message.send',
                messageId: id(1000 + sequence),
                messageSequence: sequence,
                sent: { kind: 'content', target: SCROLL_TARGET },
              },
            };
          }
          case '/v1/social/conversations/challenge/lock': {
            if (recordingPaused[who])
              return {
                json: {
                  version: 'direct-conversation.v1',
                  scope,
                  operation: 'challenge.lock',
                  recorded: false,
                  reason: 'recording_paused',
                  currentGeneration: 2,
                },
              };
            const target = messages.find((message) => message.messageId === body['messageId']);
            if (target === undefined)
              return {
                status: 404,
                json: {
                  type: 'https://knowscroll.space/problems/SHARING_UNAVAILABLE',
                  title: 'SHARING_UNAVAILABLE',
                  status: 404,
                  code: 'SHARING_UNAVAILABLE',
                },
              };
            const standing = picks[who] !== undefined;
            if (!standing) {
              picks[who] = Number(body['option']);
              target.changeSequence = ++changes;
            }
            return {
              json: {
                version: 'direct-conversation.v1',
                scope,
                operation: 'challenge.lock',
                recorded: true,
                conversation: challengeConversation(who),
                messageId: body['messageId'],
                result: standing ? 'stands' : 'locked',
              },
            };
          }
          case '/v1/social/conversations/read': {
            if (!started && messages.length === 0)
              return { json: { ...direct, readId: body['readId'], status: 'unavailable' } };
            const limit = Number(body['limit']);
            return {
              json: {
                ...direct,
                readId: body['readId'],
                status: 'ready',
                conversation: challengeConversation(who),
                peer: people[other(who)],
                own: { readThroughSequence: readThrough[who], muted: false },
                latestMessageSequence: messages.length,
                messages: messages.slice(-limit).map((message) => view(message, who)),
                limit,
                history: { kind: 'end' },
                catchUpCursor: cursor(changes),
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
                conversation: challengeConversation(who),
                limit: body['limit'],
                requestCursor: body['cursor'],
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
          case '/v1/social/conversations/mark-read':
            readThrough[who] = Math.max(readThrough[who], Number(body['throughSequence']));
            return {
              json: {
                ...receipt(body),
                operation: 'conversation.read',
                requestedThroughSequence: body['throughSequence'],
                acceptedThroughSequence: readThrough[who],
              },
            };
          case '/v1/social/read-receipts':
            return { json: { version: 'sharing.v1', scope, readReceiptsRevision: 1, shared: false } };
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
          default:
            return undefined;
        }
      };
    },
  };
  return world;
}

export type ChallengeWorld = ReturnType<typeof challengeWorld>;

/** Signs the page in as Ravi, who only reads his conversation, and answers it from the shared world. */
export async function openRavi(page: Page, world: ChallengeWorld, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: accounts.ravi, client: 'web', expiresAt: '2099-10-24T00:00:00.000Z' } }),
  );
  const answer = world.handler('ravi');
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          version: 'recording-policy.v1',
          ...body,
          scope: { accountId: accounts.ravi.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    return route.fulfill(answer(path, body) ?? { status: 404, json: {} });
  });
  await page.goto(challengeAddress('ravi'));
}

/**
 * Asha's page is the Explore fixture (the Scroll on screen) with this world's Social routes in front of it. A route
 * registered later is tried first, and a path this world does not own falls back to the Explore fixture.
 */
export async function routeAshaSocial(page: Page, world: ChallengeWorld) {
  const answer = world.handler('asha');
  await page.route('**/v1/social/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const served = answer(path, body);
    return served === undefined ? route.fallback() : route.fulfill(served);
  });
}
