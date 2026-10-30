import type { Page } from '@playwright/test';
import { id } from './encounter-fixture';

/**
 * Talk over labelled HTTP fixtures (no backend): a content thread (a series of three Reels, three
 * people, a few messages) and one direct conversation with Ravi, listed in the inbox. Authored
 * names, never product data.
 */
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'thread@fixture.test' };
const scope = { accountId: account.accountId, privacyEpoch: 1 };
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(10 + n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: `${name} fixture`,
});
const asha = person(0, 'Asha');
const ravi = person(1, 'Ravi');
const meera = person(2, 'Meera');
export const conversation = { conversationId: id(20), membershipId: id(21), membershipRevision: 1 };
export const thread = { threadId: id(60), membershipId: id(61), membershipRevision: 1 };
const episodes = [1, 2, 3].map((part) => ({
  assetId: id(300 + part),
  assetRevision: 1,
  kind: 'reel' as const,
  part,
  title: `CI part ${String(part)}`,
  state: 'ready' as const,
  visited: part === 1,
}));
const cursor = (n: number) => `kcc1_${'A'.repeat(25)}${String(n)}`;
const text = (sequence: number, author: typeof asha, value: string) => ({
  messageId: id(100 + sequence),
  sequence,
  status: 'available' as const,
  author,
  recordedAt: '2026-10-24T08:00:00.000Z',
  body: { kind: 'text' as const, text: value },
});
/** A reply's quote and a message's reactions, as the server sends them (T-B). */
const quoteOf = (sequence: number, author: typeof asha, preview: string) => ({
  messageId: id(100 + sequence),
  sequence,
  original: { status: 'available' as const, author, preview },
});
const messages = [
  text(1, ravi, 'That last part surprised me.'),
  {
    ...text(2, asha, 'Look at this one.'),
    reactions: [
      { kind: 'spark' as const, mine: false, people: [ravi, meera] },
      { kind: 'heart' as const, mine: true, people: [asha] },
    ],
  },
  {
    ...text(3, meera, 'I will catch up on Part 3 tonight.'),
    replyTo: quoteOf(1, ravi, 'That last part surprised me.'),
  },
];

/** Every request the fixture answered, in order, so a test can count a read or an open. */
export interface TalkCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export async function talkFixture(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account, client: 'web', expiresAt: '2099-10-24T00:00:00.000Z' } }),
  );
  const calls: TalkCall[] = [];
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    const base = { version: 'content-thread.v1', readId: body['readId'], scope };
    const direct = { version: 'direct-conversation.v1', readId: body['readId'], scope };
    const lastDirect = { ...text(2, ravi, 'Did you see the second part?') };
    if (path === '/v1/social/conversations/inbox')
      return route.fulfill({
        json: {
          ...direct,
          status: 'ready',
          limit: body['limit'],
          viewRevision: 1,
          items: [
            {
              conversation,
              peer: ravi,
              latestMessageSequence: 2,
              own: { readThroughSequence: 2, muted: false },
              lastMessage: lastDirect,
            },
          ],
          continuation: { kind: 'end' },
        },
      });
    if (path === '/v1/social/threads/inbox')
      return route.fulfill({
        json: { ...base, status: 'ready', limit: body['limit'], viewRevision: 1, items: [] },
      });
    if (path === '/v1/social/conversations/read')
      return route.fulfill({
        json: {
          ...direct,
          status: 'ready',
          conversation,
          peer: ravi,
          own: { readThroughSequence: 2, muted: false },
          latestMessageSequence: 2,
          messages: [
            {
              ...text(1, asha, 'Starting the second part now.'),
              reactions: [
                { kind: 'heart', mine: false, people: [ravi] },
                { kind: 'ha', mine: true, people: [asha, ravi] },
              ],
            },
            { ...lastDirect, replyTo: quoteOf(1, asha, 'Starting the second part now.') },
          ],
          limit: body['limit'],
          history: { kind: 'end' },
          catchUpCursor: cursor(2),
        },
      });
    if (path === '/v1/social/conversations/changes')
      return route.fulfill({
        json: {
          ...direct,
          status: 'ready',
          conversation,
          limit: body['limit'],
          requestCursor: body['cursor'],
          fromChangeSequence: 2,
          throughChangeSequence: 2,
          changes: [],
          continuation: { kind: 'caught_up', cursor: cursor(2) },
        },
      });
    if (path === '/v1/social/conversations/mark-read')
      return route.fulfill({
        json: {
          ...direct,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'conversation.read',
          conversation,
          requestedThroughSequence: 2,
          acceptedThroughSequence: 2,
        },
      });
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: { version: 'recording-policy.v1', ...body, scope, revision: 0, policy: { on: true, generation: 1 } },
      });
    if (path === '/v1/social/threads/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          thread,
          name: 'CI series',
          root: {
            status: 'available',
            target: { assetId: episodes[0]!.assetId, assetRevision: 1 },
            metadata: { kind: 'reel', title: 'CI part 1', summary: 'Fixture summary.', language: 'en' },
          },
          participants: [
            { person: asha, role: 'starter', joined: true, you: true },
            { person: ravi, role: 'member', joined: true, you: false },
            { person: meera, role: 'member', joined: true, you: false },
          ],
          sequence: { kind: 'series', total: 3 },
          episodes,
          own: { readThroughSequence: 3, muted: false },
          latestMessageSequence: messages.length,
          messages,
          limit: 30,
          history: { kind: 'end' },
          catchUpCursor: cursor(messages.length),
        },
      });
    if (path === '/v1/social/threads/changes')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          thread,
          limit: 50,
          requestCursor: body['cursor'],
          fromChangeSequence: messages.length,
          throughChangeSequence: messages.length,
          changes: [],
          continuation: { kind: 'caught_up', cursor: cursor(messages.length) },
        },
      });
    if (path === '/v1/social/threads/mark-read')
      return route.fulfill({
        json: {
          version: 'content-thread.v1',
          scope,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'thread.read',
          thread,
          requestedThroughSequence: messages.length,
          acceptedThroughSequence: messages.length,
        },
      });
    // A Reel opened from the thread: open, media grant, activate, then the recorder's batches.
    if (path === '/v1/experience/open')
      return route.fulfill({
        json: {
          commandId: body['commandId'],
          exposureId: id(400),
          assetId: (body['target'] as { assetId: string }).assetId,
          assetRevision: 1,
          kind: 'reel',
          revision: 1,
          replayed: false,
        },
      });
    if (path === '/v1/media/grants')
      return route.fulfill({
        json: {
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: episodes[0]!.assetId,
            revision: 1,
            title: 'CI part 1',
            summary: 'CI playback fixture',
            language: 'en',
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
            durationMs: 20000,
            width: 1080,
            height: 1920,
          },
          path: '/media/talk-fixture',
          expiresAt: '2099-10-24T18:00:00.000Z',
        },
      });
    if (path === '/v1/experience/activate')
      return route.fulfill({
        json: {
          commandId: body['commandId'],
          exposureId: id(400),
          activatedAt: '2026-10-24T10:00:00.000Z',
          revision: 1,
          replayed: false,
        },
      });
    if (path === '/v1/observations/recording-batch') {
      const events = body['events'] as { eventId: string }[];
      return route.fulfill({
        json: {
          version: 'observation-batch.v2',
          result: 'processed',
          recordingGeneration: body['recordingGeneration'],
          currentGeneration: body['recordingGeneration'],
          scope,
          accepted: events.length,
          duplicates: 0,
          rejected: 0,
          results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
          revision: 1,
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return { thread, calls };
}
