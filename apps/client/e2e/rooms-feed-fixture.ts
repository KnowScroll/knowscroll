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

export interface FeedWorld {
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

/** The Now strip's word for the newest find, for a reader who can see one. */
export const feedStrip = (world: FeedWorld) =>
  world.aiLevel === 'off' || !world.posts
    ? undefined
    : world.scoutPost
      ? { by: scoutAuthor, postedAt: hoursAgo(1) }
      : { by: nova, postedAt: hoursAgo(2) };

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

/** What a post says for this reader's AI level: the note in full, or held back for a Quieter reader. */
function postsOf(world: FeedWorld) {
  if (!world.posts || world.aiLevel === 'off') return [];
  const quiet = world.aiLevel === 'quieter';
  const note = (text: string) => (quiet ? { folded: true as const } : { note: text });
  const scouts = world.scoutPost
    ? [
        {
          discussionId: scoutFindId,
          author: scoutAuthor,
          postedAt: hoursAgo(1),
          content: SCROLL,
          ...note('A short walk through the two ways to weigh a galaxy, and where they differ.'),
          replies: 0,
        },
      ]
    : [];
  return [
    ...scouts,
    {
      discussionId: findId,
      author: nova,
      postedAt: hoursAgo(2),
      content: REEL,
      ...note('Worth a look: a short walk through how a cluster’s mass shows up as a bent arc of light.'),
      replies: 2,
    },
    {
      discussionId: secondFindId,
      author: halley,
      postedAt: hoursAgo(10),
      content: SCROLL,
      ...note('Check which of the two methods the Scroll treats as the standard, and why they disagree a little.'),
      replies: 0,
    },
  ];
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
          posts: postsOf(world),
          residents: [
            { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
            { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
          ],
          memory: world.memory,
          canEditMemory: world.canEditMemory,
          aiLevel: world.aiLevel,
          limits: { postsPerDay: 3, restHours: 6 },
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
  await page.route('**/v1/rooms/moderate', answer);
  return { calls };
}
