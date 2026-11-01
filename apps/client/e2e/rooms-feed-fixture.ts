import type { Page, Route } from '@playwright/test';
import { id } from './encounter-fixture';
import { room } from './rooms-fixture';

/**
 * The residents' feed (v3 R-8) over labelled HTTP fixtures: authored names, titles and notes, never product data and never a
 * model's words. `FeedWorld` is the room's feed as the server would read it for one person; a test changes it to say what
 * another read finds (a moderator replaces what the residents remember, the reader turns their AI level to Quieter or Off).
 */
export const findId = id(530);
export const secondFindId = id(531);
const reelId = id(532);
const scrollId = id(533);

const nova = { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' };
const halley = { kind: 'ai' as const, inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic' };

/** The member who sent a scout, as a find signs it: an authored example, never product data. */
export const asha = { kind: 'person' as const, personId: id(540), handle: 'asha', displayName: 'Asha' };
export const scoutFindId = id(541);
const scoutAuthor = { kind: 'agent' as const, sentBy: asha, label: 'AI · Scout' as const };
const CHOICES = [
  { id: 'astro.dark-matter', label: 'Dark matter' },
  { id: 'astro.galaxies', label: 'Galaxies' },
  { id: 'astro.lensing', label: 'Gravitational lensing' },
  { id: 'astro.pulsars', label: 'Pulsars' },
];

/** The reader's own scout as the server would say it; absent while scouts are off in the world. */
export interface ScoutWorld {
  state: 'none' | 'on';
  interests: string[];
  cadence: 'daily' | 'weekly';
  paused: boolean;
  stopped: boolean;
}

/** Members' posts (v3 R-8b): authored examples, never product data. */
export const deviPostId = id(550);
export const sourcePostId = id(551);
export const introId = id(553);
const secondIntroId = id(554);
export const devi = { kind: 'person' as const, personId: id(560), handle: 'devi', displayName: 'Devi' };
export const omar = { kind: 'person' as const, personId: id(561), handle: 'omar', displayName: 'Omar' };
export const you = { kind: 'person' as const, personId: id(562), handle: 'you', displayName: 'You' };

/** What a person has done to the posts of the room, as the server would hold it for this one reader. */
export interface PostState {
  votes: number;
  youVoted: boolean;
}

export interface FeedWorld {
  /** Members' posts are in the feed: Ravi's Reel, Kenji's source, and whatever the reader posted. */
  memberPosts: boolean;
  /** The votes on each post and whether the reader voted, by discussion ID. */
  votes: Record<string, PostState>;
  /** Posts the reader made during the test. */
  made: {
    discussionId: string;
    title: string;
    words: string;
    link: { kind: string; url?: string; assetId?: string };
  }[];
  /** The order and window the reader asked for last. */
  sort: 'hot' | 'new' | 'top';
  window: 'day' | 'week' | 'month' | 'all';
  /** The reader may post now (the room is open and they have posts left today). */
  canPost: boolean;
  /** The next post the reader makes is one the room already has (`already_there`), or is refused as too many. */
  nextPost?: 'already_there' | 'rate_limited';
  /** The reader is a moderator and each resident's introduction (v3 R-8b): made or not yet. */
  introduced: { explainer: boolean; skeptic: boolean };
  /** The reader's scout; absent while scouts are not switched on. */
  scout?: ScoutWorld;
  /** A find a scout posted, signed by Asha, is in the feed. */
  scoutPost: boolean;
  aiLevel: 'lively' | 'quieter' | 'off';
  canEditMemory: boolean;
  memory: { state: 'none' } | { state: 'ready'; text: string; by: 'residents' | 'moderator' };
  /** Whether the library has had anything new for the room: an empty feed says so honestly. */
  posts: boolean;
}

export const feedWorld = (patch: Partial<FeedWorld> = {}): FeedWorld => ({
  memberPosts: false,
  introduced: { explainer: false, skeptic: false },
  votes: {},
  made: [],
  sort: 'hot',
  window: 'week',
  canPost: true,
  aiLevel: 'lively',
  canEditMemory: false,
  memory: { state: 'none' },
  posts: true,
  scoutPost: false,
  ...patch,
});

const scoutView = (scout: ScoutWorld) =>
  scout.state === 'none'
    ? { state: 'none' as const, choices: CHOICES }
    : {
        state: 'on' as const,
        choices: CHOICES,
        interests: scout.interests,
        cadence: scout.cadence,
        paused: scout.paused,
        stopped: scout.stopped,
      };

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/**
 * The live strip's events for this reader (v3 R-8b): who posted and who replied, newest first, at most three. A reader whose AI is Off
 * is told only of people.
 */
export const liveStrip = (world: FeedWorld) => {
  const agents =
    world.aiLevel === 'off' || !world.posts
      ? []
      : [
          world.scoutPost
            ? { kind: 'posted', by: scoutAuthor, at: hoursAgo(1), discussionId: scoutFindId }
            : { kind: 'posted', by: nova, at: hoursAgo(2), discussionId: findId },
        ];
  const people = world.memberPosts
    ? [
        {
          kind: 'replied',
          by: { kind: 'person', person: omar, you: false },
          at: hoursAgo(0.1),
          discussionId: deviPostId,
        },
        {
          kind: 'posted',
          by: { kind: 'person', person: devi, you: false },
          at: hoursAgo(0.2),
          discussionId: deviPostId,
        },
      ]
    : [];
  const events = [...people, ...agents].slice(0, 3);
  return events.length === 0 ? undefined : events;
};

const REEL = {
  status: 'available' as const,
  target: { assetId: reelId, assetRevision: 1 },
  metadata: {
    kind: 'reel' as const,
    title: 'Light that bends around something we can’t see',
    summary: 'A galaxy cluster bends the light of galaxies far behind it.',
    language: 'en',
  },
};
const SCROLL = {
  status: 'available' as const,
  target: { assetId: scrollId, assetRevision: 1 },
  metadata: {
    kind: 'scroll' as const,
    title: 'How astronomers weigh a galaxy',
    summary: 'Orbits and lensing give two ways to measure the same mass.',
    language: 'en',
  },
};

/** What a find says for this reader's AI level: the note in full, or held back for a Quieter reader. */
function postsOf(world: FeedWorld) {
  const quiet = world.aiLevel === 'quieter';
  const note = (text: string) => (quiet ? { folded: true as const } : { note: text });
  const counted = (discussionId: string, votes: number) => {
    const state = world.votes[discussionId];
    return { votes: state?.votes ?? votes, youVoted: state?.youVoted ?? false };
  };
  const find = (
    discussionId: string,
    author: typeof nova | typeof halley | typeof scoutAuthor,
    postedAt: string,
    content: typeof REEL | typeof SCROLL,
    text: string,
    replies: number,
    votes: number,
  ) => ({
    kind: 'find' as const,
    discussionId,
    author,
    postedAt,
    content,
    ...note(text),
    replies,
    ...counted(discussionId, votes),
    canVote: true,
  });
  const finds =
    !world.posts || world.aiLevel === 'off'
      ? []
      : [
          ...(world.scoutPost
            ? [
                find(
                  scoutFindId,
                  scoutAuthor,
                  hoursAgo(1),
                  SCROLL,
                  'A short walk through the two ways to weigh a galaxy, and where they differ.',
                  0,
                  0,
                ),
              ]
            : []),
          find(
            findId,
            nova,
            hoursAgo(2),
            REEL,
            'Worth a look: a short walk through how a cluster’s mass shows up as a bent arc of light.',
            2,
            14,
          ),
          find(
            secondFindId,
            halley,
            hoursAgo(10),
            SCROLL,
            'Check which of the two methods the Scroll treats as the standard, and why they disagree a little.',
            0,
            3,
          ),
        ];
  const member = (
    discussionId: string,
    author: typeof devi | typeof omar | typeof you,
    postedAt: string,
    title: string,
    words: string,
    link: { kind: 'content'; content: typeof REEL } | { kind: 'source'; source: { url: string; host: string } },
    votes: number,
    replies: number,
  ) => ({
    kind: 'post' as const,
    discussionId,
    author: { kind: 'person' as const, person: author, you: author === you },
    postedAt,
    title,
    words,
    link,
    replies,
    ...counted(discussionId, votes),
    canVote: author !== you,
  });
  const people = world.memberPosts
    ? [
        member(
          deviPostId,
          devi,
          hoursAgo(0.2),
          'Found a Reel on gravitational lensing',
          'At 0:40 the arc isn’t a weird galaxy. It’s a normal one far behind, stretched by mass we mostly can’t see.',
          { kind: 'content', content: REEL },
          6,
          3,
        ),
        member(
          sourcePostId,
          omar,
          hoursAgo(5),
          'A paper on how clusters are weighed',
          'The method section is short and worth a read before the Scroll.',
          { kind: 'source', source: { url: 'https://www.nature.com/articles/s41586-020-2649-2', host: 'nature.com' } },
          2,
          0,
        ),
        ...world.made.map((made) =>
          member(
            made.discussionId,
            you,
            hoursAgo(0.01),
            made.title,
            made.words,
            made.link.kind === 'source'
              ? {
                  kind: 'source',
                  source: { url: made.link.url ?? '', host: new URL(made.link.url ?? 'https://x.org').hostname },
                }
              : { kind: 'content', content: REEL },
            0,
            0,
          ),
        ),
      ]
    : [];
  const intros = (['explainer', 'skeptic'] as const).flatMap((inhabitant) =>
    world.introduced[inhabitant] && world.aiLevel !== 'off'
      ? [
          {
            kind: 'intro' as const,
            discussionId: inhabitant === 'explainer' ? introId : secondIntroId,
            author: inhabitant === 'explainer' ? nova : halley,
            postedAt: hoursAgo(0.5),
            text: `Hi, I'm ${inhabitant === 'explainer' ? 'Nova' : 'Halley'}. I say what I do once, and then I only speak when there is something to add.`,
            replies: 0,
            ...counted(inhabitant === 'explainer' ? introId : secondIntroId, 0),
            canVote: true,
          },
        ]
      : [],
  );
  const all = [...finds, ...people, ...intros];
  const time = (post: { postedAt: string }) => new Date(post.postedAt).getTime();
  if (world.sort === 'new') return all.sort((x, y) => time(y) - time(x));
  if (world.sort === 'top') return all.sort((x, y) => y.votes - x.votes || time(y) - time(x));
  // Hot: the fixture's own order is the one the server would give: the most recent voted post first.
  return all.sort(
    (x, y) =>
      (y.votes + 1) / (1 + (Date.now() - time(y)) / 3_600_000) ** 1.5 -
      (x.votes + 1) / (1 + (Date.now() - time(x)) / 3_600_000) ** 1.5,
  );
}

/** Each resident's profile as the server would build it from the room's own rows (v3 R-8b). */
function profilesOf(world: FeedWorld) {
  const profile = (
    inhabitant: 'explainer' | 'skeptic',
    caresAbout: string[],
    last: number | undefined,
    recent: { discussionId: string; messageId: string; title: string; postedAt: string }[],
  ) => ({
    inhabitant,
    madeBy: 'KnowScroll' as const,
    caresAbout,
    roomSince: '2026-10-02T10:00:00.000Z',
    ...(last === undefined ? {} : { lastAt: hoursAgo(last), nextAfter: hoursAgo(last - 6) }),
    introduced: world.introduced[inhabitant],
    recent,
  });
  return [
    profile(
      'explainer',
      ['Plain explanations', 'Finds from the library', 'Where an idea comes from'],
      world.posts && world.aiLevel !== 'off' ? 2 : undefined,
      world.posts && world.aiLevel !== 'off'
        ? [{ discussionId: findId, messageId: id(580), title: REEL.metadata.title, postedAt: hoursAgo(2) }]
        : [],
    ),
    profile('skeptic', ['Strong claims', 'What the evidence says', 'Myths that stick'], undefined, []),
  ].map((entry) =>
    entry.nextAfter !== undefined && new Date(entry.nextAfter).getTime() < Date.now()
      ? { ...entry, nextAfter: undefined }
      : entry,
  );
}

/** The calls a person's screen made to the feed routes, so a test can see what was sent. */
export interface FeedCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * Answers the feed read and the moderator's memory command for one person. Register it after `roomFixture`: its routes are matched
 * first and everything else falls through to the room's own fixture.
 */
export async function feedRoutes(page: Page, world: FeedWorld, scope: { accountId: string; privacyEpoch: number }) {
  const calls: FeedCall[] = [];
  const answer = (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (path === '/v1/rooms/feed/read') {
      world.sort = (body['sort'] as FeedWorld['sort'] | undefined) ?? 'hot';
      world.window = (body['window'] as FeedWorld['window'] | undefined) ?? 'week';
    }
    if (path === '/v1/rooms/feed/vote') {
      const discussionId = body['discussionId'] as string;
      const voted = body['voted'] === true;
      const before = postsOf(world).find((post) => post.discussionId === discussionId);
      const current = before?.votes ?? 0;
      const was = before?.youVoted === true;
      world.votes[discussionId] = { votes: current + (voted ? 1 : 0) - (was ? 1 : 0), youVoted: voted };
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.post-vote',
          roomId: room.roomId,
          discussionId,
          voted,
          votes: world.votes[discussionId].votes,
        },
      });
    }
    if (path === '/v1/rooms/preferences') {
      world.aiLevel = body['aiLevel'] === 'off' ? 'off' : 'lively';
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.preferences',
          roomId: room.roomId,
          you: { aiLevel: world.aiLevel, keepOut: false },
        },
      });
    }
    if (path === '/v1/rooms/feed/introduce') {
      const inhabitant = body['inhabitant'] as 'explainer' | 'skeptic';
      world.introduced[inhabitant] = true;
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.resident-introduce',
          roomId: room.roomId,
          discussionId: inhabitant === 'explainer' ? introId : secondIntroId,
          result: 'introduced',
        },
      });
    }
    if (path === '/v1/rooms/feed/post') {
      if (world.nextPost === 'rate_limited')
        return route.fulfill({
          status: 429,
          json: { type: 'about:blank', title: 'Too many', status: 429, code: 'TOO_MANY_REQUESTS' },
        });
      const link = body['link'] as { kind: string; url?: string; target?: { assetId: string } };
      const discussionId = world.nextPost === 'already_there' ? deviPostId : id(570 + world.made.length);
      if (world.nextPost !== 'already_there')
        world.made.push({
          discussionId,
          title: body['title'] as string,
          words: body['words'] as string,
          link: {
            kind: link.kind,
            ...(link.url === undefined ? {} : { url: link.url }),
            ...(link.target === undefined ? {} : { assetId: link.target.assetId }),
          },
        });
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.find-post',
          roomId: room.roomId,
          discussionId,
          result: world.nextPost === 'already_there' ? 'already_there' : 'posted',
        },
      });
    }
    if (path === '/v1/rooms/feed/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          roomId: room.roomId,
          identity: {
            kit: {
              version: 'station-kit.v1',
              palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
              emblem: { frame: 'circle', glyph: 'ringed-planet' },
              motif: 'constellation',
              motion: 'twinkle',
              cast: { explainer: 'star', skeptic: 'atom' },
            },
          },
          sort: world.sort,
          window: world.window,
          roomName: room.name,
          profiles: profilesOf(world),
          posts: postsOf(world),
          canPost: world.canPost,
          residents: [
            { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
            { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
          ],
          memory: world.memory,
          canEditMemory: world.canEditMemory,
          aiLevel: world.aiLevel,
          limits: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
          ...(world.scout === undefined ? {} : { scout: scoutView(world.scout) }),
        },
      });
    if (path === '/v1/rooms/scout/set' && world.scout !== undefined) {
      const chosen = body['scout'] as { interests: string[]; cadence: 'daily' | 'weekly'; paused: boolean } | null;
      world.scout =
        chosen === null
          ? { ...world.scout, state: 'none', interests: [], paused: false }
          : { ...world.scout, state: 'on', ...chosen };
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.scout-set',
          roomId: room.roomId,
          scout: scoutView(world.scout),
        },
      });
    }
    if (path === '/v1/rooms/moderate') {
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.moderate',
          roomId: room.roomId,
          action: (body['action'] as { kind: string }).kind,
        },
      });
    }
    if (path === '/v1/rooms/memory/replace') {
      const text = body['text'] as string | null;
      world.memory = text === null ? { state: 'none' } : { state: 'ready', text, by: 'moderator' };
      return route.fulfill({
        json: {
          ...base,
          commandId: body['commandId'],
          recordedAt: new Date().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'room.memory-replace',
          roomId: room.roomId,
          memory: world.memory,
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  };
  await page.route('**/v1/rooms/{feed,memory,scout}/**', answer);
  await page.route('**/v1/rooms/preferences', answer);
  await page.route('**/v1/rooms/moderate', answer);
  return { calls };
}
