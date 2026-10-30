import type { Page } from '@playwright/test';
import type { RoomYou } from '@knowscroll/contracts';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { id } from './encounter-fixture';

/**
 * One room, seen by a member, over labelled HTTP fixtures (no backend): the room's band with who has it open, General
 * with a few messages, and the answers to the member's own settings and presence. Authored names, never product data.
 */
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'room@fixture.test' };
const scope = { accountId: account.accountId, privacyEpoch: 1 };
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(10 + n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const ravi = person(0, 'Ravi');
const asha = person(1, 'Asha');
const kenji = person(2, 'Kenji');
export const room = {
  roomId: id(500),
  name: 'Space room',
  description: 'Stars, planets, black holes and how we know any of it.',
  topic: { kind: 'system' as const, id: 'astronomy', label: 'Astronomy' },
  joinRule: 'open' as const,
  status: 'open' as const,
};
export const generalId = id(501);
const inhabitants = [
  { inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
  { inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
];
const cursor = (n: number) => `krc1_${'A'.repeat(25)}${String(n)}`;
const text = (sequence: number, author: typeof asha, value: string, minutesAgo: number) => ({
  messageId: id(600 + sequence),
  sequence,
  status: 'available' as const,
  author,
  recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  body: { kind: 'text' as const, text: value },
});

export interface RoomFixtureOptions {
  /** How many people have the room open besides the reader: 0 and 1 give faces only, 2 and more a number. */
  readonly others: 0 | 1 | 2 | 3;
  /** Minutes since the last message; a long time makes the room quiet. */
  readonly lastMessageMinutesAgo: number;
  /** Whether the AI notice was already read. */
  readonly noticeSeen: boolean;
  /**
   * A resident (Nova) answered a question on its own, as this reader's AI level shows it: in full (`lively`), folded
   * to one line (`quieter`) or as a marker with no words (`off`). Omitted means no resident has spoken.
   */
  readonly resident?: 'lively' | 'quieter' | 'off';
}

/** Every request the fixture answered, in order, so a test can see what the screen asked for. */
export interface RoomCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export async function roomFixture(
  page: Page,
  viewport: { width: number; height: number },
  options: RoomFixtureOptions,
) {
  await page.setViewportSize(viewport);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account, client: 'web', expiresAt: '2099-10-24T00:00:00.000Z' } }),
  );
  const calls: RoomCall[] = [];
  const others = [asha, kenji, person(3, 'Lena')].slice(0, options.others);
  const faces = [{ person: ravi, you: true }, ...others.map((other) => ({ person: other, you: false }))];
  const spoken = [
    text(1, asha, 'Wait, is dark matter just black holes we can’t see?', options.lastMessageMinutesAgo + 6),
    text(2, kenji, 'Lensing says it’s spread out, not clumped.', options.lastMessageMinutesAgo + 3),
    text(3, asha, 'Huh. Then what is it?', options.lastMessageMinutesAgo),
  ];
  // A resident that answered the last question on its own, as this reader's AI level receives it (R-2).
  const resident =
    options.resident === undefined
      ? []
      : options.resident === 'off'
        ? [{ messageId: id(604), sequence: 4, status: 'muted' as const }]
        : [
            {
              messageId: id(604),
              sequence: 4,
              status: 'available' as const,
              author: { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' },
              recordedAt: new Date(Date.now() - Math.max(options.lastMessageMinutesAgo - 4, 0) * 60_000).toISOString(),
              body: {
                kind: 'text' as const,
                text: 'Lensing maps show the missing mass spread out like a halo around a galaxy, not packed into dark stars.',
              },
              suggestion: 'explanation' as const,
              trigger: 'unanswered_question' as const,
              ...(options.resident === 'quieter' ? { folded: true as const } : {}),
            },
          ];
  const messages = [...spoken, ...resident];
  const lastAt = spoken.at(-1)!.recordedAt;
  const state: { you: RoomYou } = {
    you: {
      aiLevel: 'lively',
      keepOut: false,
      ...(options.noticeSeen ? { noticeSeenAt: '2026-10-24T08:00:00.000Z' } : {}),
    },
  };
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (isInboxPath(path) && path !== '/v1/rooms/list')
      return route.fulfill({ json: emptyInbox(path, body, account.accountId) });
    if (path === '/v1/rooms/list')
      return route.fulfill({ json: { ...base, status: 'ready', items: [{ room, standing: 'member' }] } });
    if (path === '/v1/rooms/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'member',
          room,
          role: 'member',
          guidelines: 'Say where an idea came from. Be kind to newcomers.',
          hasModerator: true,
          inhabitants,
          general: {
            discussionId: generalId,
            kind: 'general',
            title: 'General',
            pinned: false,
            lastActivityAt: lastAt,
          },
          discussions: [
            {
              discussionId: id(502),
              kind: 'topic',
              title: 'Dark matter or modified gravity?',
              pinned: true,
              lastActivityAt: '2026-10-24T07:00:00.000Z',
              startedBy: asha,
            },
          ],
          canPost: true,
          you: state.you,
          here: { faces, ...(faces.length >= 3 ? { count: faces.length } : {}) },
          memberTotal: 24,
          lastMessageAt: lastAt,
        },
      });
    if (path === '/v1/rooms/discussions/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          room,
          role: 'member',
          you: ravi,
          discussion: { discussionId: generalId, kind: 'general', title: 'General', pinned: false },
          canPost: true,
          inhabitants: inhabitants.map((entry) => ({ ...entry, ask: 'available' })),
          latestMessageSequence: messages.length,
          messages,
          limit: body['limit'],
          history: { kind: 'end' },
          catchUpCursor: cursor(messages.length),
        },
      });
    if (path === '/v1/rooms/discussions/changes')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          limit: body['limit'],
          requestCursor: body['cursor'],
          changes: [],
          continuation: { kind: 'caught_up', cursor: cursor(messages.length) },
        },
      });
    if (path === '/v1/rooms/presence')
      return route.fulfill({ json: { version: 'rooms.v1', scope, roomId: room.roomId, state: body['state'] } });
    if (path === '/v1/rooms/preferences') {
      state.you = {
        ...state.you,
        ...(body['aiLevel'] === undefined ? {} : { aiLevel: body['aiLevel'] as RoomYou['aiLevel'] }),
        ...(body['keepOut'] === undefined ? {} : { keepOut: body['keepOut'] as boolean }),
        ...(body['noticeSeen'] === true ? { noticeSeenAt: '2026-10-24T08:00:00.000Z' } : {}),
      };
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'room.preferences',
          roomId: room.roomId,
          you: state.you,
        },
      });
    }
    if (path === '/v1/rooms/activities/list')
      return route.fulfill({
        json: { ...base, status: 'ready', roomId: room.roomId, canCreate: false, activities: [] },
      });
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: { version: 'recording-policy.v1', ...body, scope, revision: 0, policy: { on: true, generation: 1 } },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  return { calls, address: `/rooms/${room.roomId}` };
}
