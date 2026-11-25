import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { COLLECTION_READS, fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';

/**
 * Opens the Universe with the Round 7.3 trial ("Try the new Universe") over authored HTTP fixtures: three systems, and
 * a planet with four formed regions ("CI region 4" to "CI region 7") among land not reached yet. Shared by the trial's
 * browser specs so each one sees the same world.
 */
/** Every read the Universe may send while a person only looks at it; anything else would be a write. */
export const VOYAGE_READS: ReadonlySet<string> = new Set([
  '/v1/universe/geography/read',
  '/v1/universe/geography/deltas/read',
  '/v1/universe/scenes/sky/read',
  '/v1/universe/scenes/manifest/read',
  '/v1/universe/scenes/chunks/read',
  '/v1/universe/emerging/read',
  '/v1/experience/region/preview',
  '/v1/universe/formation/read',
  '/v1/rooms/stations',
  ...COLLECTION_READS,
]);

export interface VoyageOptions {
  readonly size?: { width: number; height: number };
  readonly trial?: boolean;
  readonly calm?: boolean;
  /** The app's appearance; the Universe must look the same in both (D-400). */
  readonly appearance?: 'light' | 'dark';
  /** Stamp every frame the scene draws, for {@link frameStamps}. */
  readonly stamps?: boolean;
  /** Count the shader programs WebGL links and frees, for {@link programCounts}. */
  readonly programs?: boolean;
}

/**
 * Stamps each frame the scene draws with the time the browser gave its animation-frame callback (the stamp the 30 fps
 * cap is decided on). A frame is seen through WebGL's `clear`; the ship's layer clears depth again in the same frame,
 * so a frame is counted once per stamp.
 */
function stampFrames(): void {
  const frames: number[] = [];
  (window as unknown as { __ksFrames: number[] }).__ksFrames = frames;
  let frameStamp: number | null = null;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
  const request = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) =>
    request.call(window, (stamp) => {
      frameStamp = stamp;
      try {
        callback(stamp);
      } finally {
        frameStamp = null;
      }
    });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
  const clear = WebGL2RenderingContext.prototype.clear;
  WebGL2RenderingContext.prototype.clear = function (this: WebGL2RenderingContext, mask: number): void {
    const stamp = frameStamp ?? performance.now();
    if (frames[frames.length - 1] !== stamp) frames.push(stamp);
    clear.call(this, mask);
  };
}

/**
 * Counts the shader programs linked and freed. three.js frees a program when no material uses it any more, so a scene
 * rebuilt in the middle of a flight shows here as programs freed and linked again: a stall of hundreds of milliseconds.
 */
function countPrograms(): void {
  const counts = { linked: 0, deleted: 0 };
  (window as unknown as { __ksPrograms: typeof counts }).__ksPrograms = counts;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
  const link = WebGL2RenderingContext.prototype.linkProgram;
  WebGL2RenderingContext.prototype.linkProgram = function (this: WebGL2RenderingContext, program: WebGLProgram): void {
    counts.linked += 1;
    link.call(this, program);
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
  const remove = WebGL2RenderingContext.prototype.deleteProgram;
  WebGL2RenderingContext.prototype.deleteProgram = function (
    this: WebGL2RenderingContext,
    program: WebGLProgram | null,
  ): void {
    counts.deleted += 1;
    remove.call(this, program);
  };
}

/** The shader programs linked and freed so far (see {@link VoyageOptions.programs}). */
export const programCounts = (page: Page): Promise<{ linked: number; deleted: number }> =>
  page.evaluate(() => ({
    ...(window as unknown as { __ksPrograms: { linked: number; deleted: number } }).__ksPrograms,
  }));

/** The frame stamps recorded so far (see {@link VoyageOptions.stamps}). */
export const frameStamps = (page: Page): Promise<number[]> =>
  page.evaluate(() => [...(window as unknown as { __ksFrames: number[] }).__ksFrames]);

/**
 * One line about the frames drawn between two stamps' indices, in the readout's terms: frames a second, the share of
 * gaps of at most 51 ms (one missed refresh at the 30 fps cap) and the longest gap. Reported, never asserted: this
 * browser draws in software.
 */
export function frameLine(stamps: readonly number[]): string {
  const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
  if (gaps.length === 0) return 'no frames';
  const seconds = (stamps[stamps.length - 1]! - stamps[0]!) / 1000;
  const onTime = gaps.filter((gap) => gap <= 51).length / gaps.length;
  return `${(gaps.length / seconds).toFixed(0)} fps · ${(onTime * 100).toFixed(0)}% on time · longest ${Math.max(...gaps).toFixed(0)} ms`;
}

/** Screenshots are written only when `KS_UNIVERSE_SHOTS` names a folder (outside the repository). */
export async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env['KS_UNIVERSE_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

/**
 * Routes every read to the fixture, records each `/v1` path the page sends into `paths`, and opens `/universe`.
 * `trial: false` leaves the switch off; `calm` turns on reduced motion.
 */
export async function openVoyage(page: Page, paths: string[], options: VoyageOptions = {}): Promise<void> {
  // Three systems, and a planet with four formed regions.
  const world = sceneFixture(5, 0, 3, 2);
  await page.setViewportSize(options.size ?? { width: 390, height: 844 });
  if (options.calm === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  const preferences = {
    universeTrial: options.trial !== false,
    universeFrameRate: options.trial !== false,
    ...(options.appearance ? { appearance: options.appearance } : {}),
  };
  await page.addInitScript(
    (stored) => window.localStorage.setItem('ks.device.preferences', stored),
    JSON.stringify(preferences),
  );
  if (options.stamps === true) await page.addInitScript(stampFrames);
  if (options.programs === true) await page.addInitScript(countPrograms);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          ...body,
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    if (!isInboxPath(path) || path === '/v1/rooms/stations') paths.push(path);
    if (path === '/v1/rooms/stations') return route.fulfill({ json: world.reply(path, body) });
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, fixtureAccount.accountId) });
    if (path.endsWith('/region/preview'))
      return route.fulfill({
        json: {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
          recordedAt: '2026-10-22T00:00:00.000Z',
          geographyRevision: 3,
          status: 'available',
          encounter: {
            assetId: '0199a000-0000-7000-8000-000000000500',
            assetRevision: 1,
            metadata: {
              kind: 'reel',
              title: 'CI card title',
              summary: 'Authored fixture text, not generated content.',
              language: 'en',
            },
          },
        },
      });
    if (path.endsWith('/formation/read'))
      return route.fulfill({
        json: {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
          recordedAt: '2026-10-22T00:00:00.000Z',
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          status: 'unavailable',
          reason: 'temporarily_unavailable',
        },
      });
    return route.fulfill({ json: world.reply(path, body) });
  });
  await page.goto('/universe');
}

/**
 * Waits until no flight is under way: the screen says where a flight is going while it flies, and a tap then skips it
 * instead of reaching a place, so a test taps a place only once it has landed.
 */
export const landed = (page: Page): Promise<void> =>
  expect(page.getByTestId('voyage-flight')).toHaveCount(0, { timeout: 30_000 });

/** The readout's two lines as one, for the pull request. */
export const readoutOf = async (page: Page): Promise<string> =>
  (await page.getByTestId('universe-frame-rate').innerText()).replace(/\s+/g, ' ');
