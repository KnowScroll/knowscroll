import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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

/** The readout's two lines as one, for the pull request. */
export const readoutOf = async (page: Page): Promise<string> =>
  (await page.getByTestId('universe-frame-rate').innerText()).replace(/\s+/g, ' ');
