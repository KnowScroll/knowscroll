import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { LAUNCH_HOST } from '@knowscroll/contracts';
import { id } from './encounter-fixture';

/**
 * Watch together (v3 R-10) over labelled HTTP fixtures, for up to three people at once. The `WatchWorld` is the one room they are in and
 * it keeps the server's rules in a test's own words: one clock decides where the session is, nobody's position is stored or sent, "N
 * watching" is a number only from three people who joined and still have the room open, a person's own watch opens an encounter for
 * them alone, and a hint never arrives (these fixtures run no socket), so every change a device sees came from a durable read. The
 * timings are shorter than the product's (a lead-in of a couple of seconds, a Reel of a minute or less) so a whole session fits in one test; the
 * screen counts whatever time the view carries. Authored people and one authored Reel: never product data. The media is a labelled
 * sixty-second video of one colour.
 */
export const LEAD_IN_MS = 2_500;
const sessionId = id(960);
const REEL_ID = id(950);
const video = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/** A viewer of the room: the fixture's three people. */
export type Who = 'ravi' | 'asha' | 'kenji';
const PEOPLE = {
  ravi: { kind: 'person' as const, personId: id(10), handle: 'ci.ravi', displayName: 'Ravi' },
  asha: { kind: 'person' as const, personId: id(11), handle: 'ci.asha', displayName: 'Asha' },
  kenji: { kind: 'person' as const, personId: id(12), handle: 'ci.kenji', displayName: 'Kenji' },
};

export class WatchWorld {
  /** The Reel the room may watch: its length is the session's. */
  readonly reel: { assetId: string; assetRevision: number; title: string; durationMs: number };

  constructor(lengthMs = 60_000) {
    this.reel = { assetId: REEL_ID, assetRevision: 1, title: 'How big is the universe?', durationMs: lengthMs };
  }

  startsAt: number | undefined;
  stoppedAt: number | undefined;
  startedBy: Who | undefined;
  /** What was on the stage before: a Launch, yesterday. Read when nothing is on. */
  readonly lastAt = new Date(Date.now() - 20 * 3_600_000).toISOString();
  readonly viewers = new Set<Who>();
  /** Who has the room open: a person's lease, which a test ends by closing the person's tab. */
  readonly present = new Set<Who>();
  /** Every call a device made to a Watch route, so a test can see exactly what was sent. */
  readonly calls: { who: Who; path: string; body: Record<string, unknown> }[] = [];
  /** The Reel encounters each person opened, and the observations each person's device sent. Nothing is ever written for another. */
  readonly exposures = new Map<Who, string[]>();
  readonly observed: { who: Who; exposureId: string; kind: string }[] = [];

  /** Where the first frame is, on the world's clock: negative before it. */
  clock(now = Date.now()): number | undefined {
    return this.startsAt === undefined || this.stoppedAt !== undefined ? undefined : now - this.startsAt;
  }

  live(now = Date.now()): boolean {
    const at = this.clock(now);
    return at !== undefined && at < this.reel.durationMs;
  }

  /** The room view's own word: a Reel can be watched, or one is on. */
  strip(): { state: 'ready' | 'live' } {
    return { state: this.live() ? 'live' : 'ready' };
  }

  start(who: Who): number {
    this.startsAt = Date.now() + LEAD_IN_MS;
    this.stoppedAt = undefined;
    this.startedBy = who;
    this.viewers.clear();
    this.viewers.add(who);
    return LEAD_IN_MS;
  }

  /** The people who joined and still have the room open, counted as the server counts them for this reader. */
  private watching(viewer: Who): number | undefined {
    const counted = [...this.viewers].filter((who) => who === viewer || this.present.has(who)).length;
    return counted >= 3 ? counted : undefined;
  }

  /** The stage as `viewer` reads it now, in the contract's own shape. */
  view(viewer: Who): Record<string, unknown> {
    const at = this.clock();
    if (at === undefined || at >= this.reel.durationMs)
      return {
        start: { allowed: true },
        last:
          this.startsAt === undefined
            ? { kind: 'launch', at: this.lastAt }
            : { kind: 'reel', at: this.lastAt, title: this.reel.title },
      };
    const common = {
      sessionId,
      reel: this.reel,
      youIn: this.viewers.has(viewer),
      sharedBy: PEOPLE[this.startedBy ?? 'ravi'],
      canStop: this.startedBy === viewer,
      ...(this.watching(viewer) === undefined ? {} : { watching: this.watching(viewer) }),
    };
    return {
      session:
        at < 0 ? { phase: 'starting', ...common, startsInMs: -at } : { phase: 'playing', ...common, elapsedMs: at },
    };
  }
}

const receipt = (body: Record<string, unknown>, scope: unknown, operation: string) => ({
  version: 'rooms.v1',
  scope,
  commandId: body['commandId'],
  recordedAt: new Date().toISOString(),
  replayed: false,
  outcome: 'accepted',
  operation,
  roomId: body['roomId'],
});

const UNAVAILABLE = {
  status: 403,
  json: { type: 'about:blank', title: 'Unavailable', status: 403, code: 'SHARING_UNAVAILABLE' },
};

/** What a person's own device does: the routes that open, activate and play a Reel, and the observation of it. They are the ordinary Reel routes. */
async function reelRoutes(page: Page, world: WatchWorld, who: Who, scope: { accountId: string; privacyEpoch: number }) {
  let opened = 0;
  await page.route('**/v1/experience/open', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { commandId: string; target: { assetId: string } };
    opened += 1;
    const exposureId = id(1_000 + (who === 'ravi' ? 0 : who === 'asha' ? 100 : 200) + opened);
    world.exposures.set(who, [...(world.exposures.get(who) ?? []), exposureId]);
    return route.fulfill({
      json: {
        commandId: body.commandId,
        exposureId,
        assetId: body.target.assetId,
        assetRevision: 1,
        kind: 'reel',
        openedAt: new Date().toISOString(),
        replayed: false,
        revision: 1,
      },
    });
  });
  await page.route('**/v1/experience/activate', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    return route.fulfill({
      json: {
        commandId: body['commandId'],
        exposureId: body['exposureId'],
        activatedAt: new Date().toISOString(),
        revision: 1,
        replayed: false,
      },
    });
  });
  await page.route('**/v1/media/grants', (route) =>
    route.fulfill({
      json: {
        document: {
          schemaVersion: 'reel-document.v1',
          assetId: world.reel.assetId,
          revision: 1,
          title: world.reel.title,
          summary: 'CI fixture: a labelled video of one colour',
          language: 'en',
          truthLabel: 'generated',
          fixture: true,
          captions: 'burned_in',
          mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
          durationMs: world.reel.durationMs,
          width: 1080,
          height: 1920,
        },
        path: '/media/gesture-fixture',
        expiresAt: '2099-10-20T18:00:00.000Z',
      },
    }),
  );
  // A browser seeks a video by asking for byte ranges, so the media answers them as a media server does.
  await page.route('**/media/gesture-fixture', (route) => {
    const range = /^bytes=(d*)-(d*)$/.exec(route.request().headers()['range'] ?? '');
    if (range === null)
      return route.fulfill({
        status: 200,
        headers: { 'accept-ranges': 'bytes' },
        contentType: 'video/webm',
        body: video,
      });
    const from = range[1] === '' ? 0 : Number(range[1]);
    const to = range[2] === '' ? video.length - 1 : Math.min(Number(range[2]), video.length - 1);
    return route.fulfill({
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${String(from)}-${String(to)}/${String(video.length)}`,
      },
      contentType: 'video/webm',
      body: video.subarray(from, to + 1),
    });
  });
  await page.route('**/v1/observations/recording-batch', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      recordingGeneration: number;
      events: { eventId: string; exposureId: string; kind: string }[];
    };
    for (const event of body.events) world.observed.push({ who, exposureId: event.exposureId, kind: event.kind });
    return route.fulfill({
      json: {
        version: 'observation-batch.v2',
        result: 'processed',
        recordingGeneration: body.recordingGeneration,
        currentGeneration: body.recordingGeneration,
        scope,
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        results: body.events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
        revision: 1,
      },
    });
  });
}

/**
 * Answers the Watch routes (and the Reel's own routes) for one person. Register it after `roomFixture`: its routes are matched first and
 * everything else falls through to the room's own fixture. `dropped` makes every read of the stage fail as a dropped connection would, so
 * a test can take a device off the network without taking the page away.
 */
export async function watchRoutes(
  page: Page,
  world: WatchWorld,
  who: Who,
  scope: { accountId: string; privacyEpoch: number },
) {
  world.present.add(who);
  await reelRoutes(page, world, who, scope);
  await page.route('**/v1/rooms/launch/read', (route) =>
    route.fulfill({
      json: {
        version: 'rooms.v1',
        readId: (route.request().postDataJSON() as { readId: string }).readId,
        scope,
        status: 'ready',
        host: LAUNCH_HOST,
        start: { allowed: true },
      },
    }),
  );
  const state = { dropped: false };
  await page.route('**/v1/rooms/watch/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.calls.push({ who, path, body });
    if (state.dropped && path.endsWith('/read')) return route.abort('connectionreset');
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (path.endsWith('/read')) return route.fulfill({ json: { ...base, status: 'ready', ...world.view(who) } });
    if (path.endsWith('/reels')) return route.fulfill({ json: { ...base, status: 'ready', reels: [world.reel] } });
    if (path.endsWith('/start')) {
      if (world.live() || body['assetId'] !== world.reel.assetId) return route.fulfill(UNAVAILABLE);
      const startsInMs = world.start(who);
      return route.fulfill({ json: { ...receipt(body, scope, 'watch.start'), sessionId, startsInMs } });
    }
    if (path.endsWith('/join')) {
      if (!world.live() || body['sessionId'] !== sessionId) return route.fulfill(UNAVAILABLE);
      world.viewers.add(who);
      return route.fulfill({ json: { ...receipt(body, scope, 'watch.join'), sessionId } });
    }
    if (path.endsWith('/leave')) {
      world.viewers.delete(who);
      return route.fulfill({ json: { ...receipt(body, scope, 'watch.leave'), sessionId } });
    }
    if (path.endsWith('/stop')) {
      if (world.startedBy !== who) return route.fulfill(UNAVAILABLE);
      world.stoppedAt = Date.now();
      world.viewers.clear();
      return route.fulfill({ json: { ...receipt(body, scope, 'watch.stop'), sessionId } });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return {
    /** The network drops for this device: its reads of the stage fail until `restore`. */
    drop: () => {
      state.dropped = true;
    },
    restore: () => {
      state.dropped = false;
    },
  };
}
