import type { Page } from '@playwright/test';
import type { RoomIdentity, RoomYou } from '@knowscroll/contracts';
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

/** Labelled fixture faces (D-170), authored like R3 D's Space and History rooms; never provider output. */
export const FACES = {
  space: {
    kit: {
      version: 'station-kit.v1',
      palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
      emblem: { frame: 'circle', glyph: 'ringed-planet' },
      motif: 'constellation',
      motion: 'twinkle',
      cast: { explainer: 'star', skeptic: 'atom' },
    },
  },
  history: {
    kit: {
      version: 'station-kit.v1',
      palette: { ground: 'paper', accent: 'rust', ink: 'soot' },
      emblem: { frame: 'arch', glyph: 'hourglass' },
      motif: 'waves',
      motion: 'pan',
      cast: { explainer: 'book', skeptic: 'gear' },
    },
  },
} as const satisfies Record<string, RoomIdentity>;
/** The address a fixture backdrop is served from; the test answers it with a labelled one-pixel image. */
export const BACKDROP_PATH = `/media/room/${'ab'.repeat(32)}`;
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
  /**
   * R-3: what the room has beyond a plain conversation. `asked`: Halley answered a challenge Asha made (an AI message that
   * says who asked what); `topics`: the room has topics and a card for one in General; `welcome`: a newcomer's template
   * welcome (needs `noticeSeen: false`); `away`: this member's "while you were away".
   */
  readonly asked?: boolean;
  readonly topics?: boolean;
  readonly welcome?: boolean;
  readonly away?: 'preparing' | 'ready' | 'folded';
  /** R-4: the room's face. Default: the Space room's. `none` is a server that sends no face. */
  readonly face?: keyof typeof FACES | 'none';
  /** R-4: an operator approved a painted backdrop. */
  readonly backdrop?: boolean;
  /** R-5: the room's sky as every read of the room carries it; a function so a later read can say more. Default: no stars. */
  readonly sky?: () => Record<string, unknown>;
  /** R-5: the person's recording is paused (D-083): Spot the flaw sends nothing and says why. */
  readonly recordingPaused?: boolean;
  /** R-5: today's strip of the room view (the Today discussion, the approved question and whether there is a Spot the flaw). */
  readonly today?: Record<string, unknown>;
  /** R-6: the room view's word for the Launch (ready, lobby, live or finished), read afresh each time; absent says nothing. */
  readonly launch?: () => Record<string, unknown> | undefined;
  /** R-10: the room view's word for Watch together (ready or live), read afresh each time; absent says nothing. */
  readonly watch?: () => Record<string, unknown> | undefined;
  /** R-7: the member view's replay strip and its questions, read afresh each time; absent says nothing. */
  readonly replay?: () => Record<string, unknown> | undefined;
  readonly questions?: () => Record<string, unknown> | undefined;
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
  const face = options.face ?? 'space';
  const faced = {
    ...room,
    ...(face === 'none'
      ? {}
      : { identity: { ...FACES[face], ...(options.backdrop ? { backdrop: { path: BACKDROP_PATH } } : {}) } }),
  };
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
  // R-3: Halley answered a challenge Asha made of Kenji's message.
  const asked = options.asked
    ? [
        {
          messageId: id(605),
          sequence: 5,
          status: 'available' as const,
          author: { kind: 'ai' as const, inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic' },
          recordedAt: new Date(Date.now() - Math.max(options.lastMessageMinutesAgo - 5, 0) * 60_000).toISOString(),
          body: {
            kind: 'text' as const,
            text: 'That holds for lensing. One gap: very small primordial black holes are harder to rule out.',
          },
          suggestion: 'assumption' as const,
          ask: { kind: 'challenge' as const, by: asha, about: id(602) },
        },
      ]
    : [];
  // R-3: the card the topic leaves where it began.
  const topicCard = options.topics
    ? [
        {
          messageId: id(606),
          sequence: 6,
          status: 'available' as const,
          author: kenji,
          recordedAt: new Date(Date.now() - Math.max(options.lastMessageMinutesAgo - 6, 0) * 60_000).toISOString(),
          body: {
            kind: 'topic' as const,
            topic: {
              discussionId: id(503),
              title: 'Could we ever detect dark matter directly?',
              tag: 'question' as const,
            },
          },
        },
      ]
    : [];
  const messages = [...spoken, ...resident, ...asked, ...topicCard];
  const lastAt = spoken.at(-1)!.recordedAt;
  const topics = [
    {
      discussionId: id(502),
      kind: 'topic' as const,
      title: 'Dark matter or modified gravity?',
      tag: 'debate' as const,
      pinned: true,
      lastActivityAt: '2026-10-24T07:00:00.000Z',
      replyCount: 8,
      lastReplyBy: { name: 'Halley', ai: true },
      startedBy: asha,
      usefulCount: 9,
      answered: true,
    },
    {
      discussionId: id(503),
      kind: 'topic' as const,
      title: 'Could we ever detect dark matter directly?',
      tag: 'question' as const,
      pinned: false,
      lastActivityAt: '2026-10-24T06:00:00.000Z',
      replyCount: 7,
      lastReplyBy: { name: 'Kenji', ai: false },
      startedBy: kenji,
      usefulCount: 4,
      answered: true,
    },
    {
      discussionId: id(504),
      kind: 'topic' as const,
      title: 'Is Pluto a planet again?',
      tag: 'explainer' as const,
      pinned: false,
      lastActivityAt: '2026-10-24T05:00:00.000Z',
      replyCount: 0,
      startedBy: ravi,
      usefulCount: 0,
      answered: false,
    },
  ];
  const summaries = topics.map(({ usefulCount: _useful, answered: _answered, ...summary }) => summary);
  const state: { you: RoomYou; away: boolean } = {
    away: options.away !== undefined,
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
      return route.fulfill({ json: { ...base, status: 'ready', items: [{ room: faced, standing: 'member' }] } });
    if (path === '/v1/rooms/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'member',
          room: faced,
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
            replyCount: 0,
          },
          discussions: options.topics
            ? summaries
            : [
                {
                  discussionId: id(502),
                  kind: 'topic',
                  title: 'Dark matter or modified gravity?',
                  pinned: true,
                  lastActivityAt: '2026-10-24T07:00:00.000Z',
                  replyCount: 0,
                  startedBy: asha,
                },
              ],
          canPost: true,
          you: state.you,
          here: { faces, ...(faces.length >= 3 ? { count: faces.length } : {}) },
          memberTotal: 24,
          sky: options.sky?.() ?? { lit: 0, of: 7, state: 'forming', finished: 0 },
          ...(options.today === undefined ? {} : { today: options.today }),
          ...(options.launch?.() === undefined ? {} : { launch: options.launch() }),
          ...(options.watch?.() === undefined ? {} : { watch: options.watch() }),
          ...(options.replay?.() === undefined ? {} : { replay: options.replay() }),
          ...(options.questions?.() === undefined ? {} : { questions: options.questions() }),
          limits: {
            asked: { perPersonPerHour: 10, perRoomPerDay: 80 },
            unprompted: { humanMessagesPerTurn: 3, perHour: 8, perDay: 40, explainerPerHour: 4, skepticPerHour: 3 },
          },
          lastMessageAt: lastAt,
          ...(options.welcome && !options.noticeSeen
            ? {
                welcome: {
                  resident: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' },
                  text: 'Welcome to Space room. Stars, planets, black holes and how we know any of it. Ask me anything here, or just say hello in General.',
                },
              }
            : {}),
          ...(state.away && options.away !== undefined
            ? {
                away: {
                  resident: { kind: 'ai', inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic' },
                  since: new Date(Date.now() - 14 * 3_600_000).toISOString(),
                  state: options.away === 'preparing' ? 'preparing' : 'ready',
                  ...(options.away === 'preparing'
                    ? {}
                    : {
                        text: 'Two people compared dark matter with modified gravity.\nA new topic asks whether it can be detected directly, and one question about lensing is still open.',
                        coversFrom: new Date(Date.now() - 14 * 3_600_000).toISOString(),
                      }),
                  ...(options.away === 'folded' ? { folded: true } : {}),
                },
              }
            : {}),
        },
      });
    if (path === '/v1/rooms/discussions/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          room: faced,
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
    if (path === '/v1/rooms/topics/list') {
      const wanted = topics
        .filter((topic) => body['tag'] === undefined || topic.tag === body['tag'])
        .filter((topic) => body['sort'] !== 'unanswered' || !topic.answered);
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          roomId: room.roomId,
          sort: body['sort'],
          canPost: true,
          topics: wanted,
        },
      });
    }
    if (path === '/v1/rooms/away/dismiss') {
      state.away = false;
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'room.away-dismiss',
          roomId: room.roomId,
        },
      });
    }
    if (path === '/v1/rooms/discussions/useful')
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'message.useful',
          roomId: room.roomId,
          discussionId: body['discussionId'],
          messageId: body['messageId'],
          useful: body['useful'],
        },
      });
    if (path === '/v1/rooms/inhabitants/ask') {
      const about = body['about'] as { kind: string } | undefined;
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'inhabitant.ask',
          roomId: room.roomId,
          discussionId: body['discussionId'],
          inhabitant: about === undefined ? body['inhabitant'] : about.kind === 'about' ? 'explainer' : 'skeptic',
          kind: about === undefined ? 'ask' : about.kind,
        },
      });
    }
    if (path === '/v1/rooms/discussions/create')
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'discussion.create',
          roomId: room.roomId,
          discussionId: id(510),
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
        json: {
          version: 'recording-policy.v1',
          ...body,
          scope,
          revision: 0,
          policy: options.recordingPaused === true ? { on: false, generation: 2 } : { on: true, generation: 1 },
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  return { calls, address: `/rooms/${room.roomId}` };
}
