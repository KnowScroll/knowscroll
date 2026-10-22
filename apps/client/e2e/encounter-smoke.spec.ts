import { expect, test, type Page } from '@playwright/test';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import type { EncounterOffer, ExposureContextResponse } from '@knowscroll/contracts';

/** Actual production-export UI with explicitly labelled HTTP fixtures, not backend/provider acceptance. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
async function encounterFixture(page: Page, kind: 'scroll' | 'reel') {
  await page.setViewportSize({ width: 390, height: 844 });
  let current = 0;
  let intentRevision = 1;
  let saved = true;
  const commands: { path: string; body: Record<string, unknown> }[] = [];
  const offer = (n: number): EncounterOffer => ({
    offerId: id(100 + n),
    decisionId: id(200 + n),
    assetId: id(300 + n),
    assetRevision: document.revision,
    explanationUnitId: `ci-fixture-${String(n)}`,
    metadata: {
      kind,
      title: `CI encounter fixture ${String(n + 1)}`,
      summary: 'HTTP fixture only',
      language: 'en',
    },
    relation: { kind: 'discovery' },
    variants: [{ kind: kind === 'scroll' ? 'reel' : 'scroll', status: 'unavailable' }],
  });
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      json: {
        account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'fixture@encounter.test' },
        client: 'web',
        expiresAt: '2099-10-20T10:00:00.000Z',
      },
    }),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/experience/open' || path === '/v1/experience/navigate') {
      commands.push({ path, body });
      if (path.endsWith('/navigate')) {
        current += 1;
        intentRevision += 1;
      }
      await route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(3),
          intentRevision,
          revision: intentRevision,
          decisionId: id(4),
          replayed: false,
          status: 'ready',
          offer: offer(current),
          bufferedOffers: [],
        },
      });
      return;
    }
    if (path === '/v1/experience/activate') {
      commands.push({ path, body });
      await route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(3),
          intentRevision,
          offerId: offer(current).offerId,
          exposureId: id(400 + current),
          assetId: offer(current).assetId,
          assetRevision: document.revision,
          kind,
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision: intentRevision,
          replayed: false,
        },
      });
      return;
    }
    if (path.endsWith('/context')) {
      const n = Number(path.split('/').at(-2)!.slice(-12)) - 400;
      const context: ExposureContextResponse = {
        exposureId: id(400 + n),
        assetId: offer(n).assetId,
        assetRevision: document.revision,
        revision: intentRevision,
        session: { sessionId: id(3), intentRevision },
        actions: { saved: false, liked: false, hidden: false },
        variants: [{ kind: kind === 'scroll' ? 'reel' : 'scroll', status: 'unavailable' }],
        continuations: {
          seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
          seriesNext: { status: 'unavailable', reason: 'series_boundary' },
          related:
            kind === 'reel'
              ? {
                  status: 'ready',
                  linkId: id(800 + n),
                  target: { assetId: id(301 + n), assetRevision: document.revision },
                  metadata: {
                    kind: 'reel',
                    title: `CI encounter fixture ${String(n + 2)}`,
                    summary: 'CI related link',
                    language: 'en',
                  },
                  relation: { kind: 'related_move', label: 'CI related angle' },
                }
              : { status: 'unavailable', reason: 'no_related_ready' },
        },
      };
      await route.fulfill({ json: context });
      return;
    }
    if (path === '/v1/media/grants') {
      await route.fulfill({
        json: {
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: offer(current).assetId,
            revision: document.revision,
            title: offer(current).metadata.title,
            summary: 'CI gesture fixture; no decoded playback claimed',
            language: 'en',
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
            durationMs: 20000,
            width: 1080,
            height: 1920,
          },
          path: '/media/gesture-fixture',
          expiresAt: '2099-10-20T18:00:00.000Z',
        },
      });
      return;
    }
    if (path.endsWith('/document')) {
      const n = Number(path.split('/').at(-2)!.slice(-12)) - 400;
      await route.fulfill({
        json: {
          exposureId: id(400 + n),
          assetId: offer(n).assetId,
          assetRevision: document.revision,
          document: { ...document, assetId: offer(n).assetId, title: offer(n).metadata.title },
          degradedEssential: [],
        },
      });
      return;
    }
    if (path === '/v1/saved') {
      await route.fulfill({
        json: {
          revision: 1,
          items: saved
            ? [
                {
                  assetId: id(990),
                  assetRevision: 2,
                  savedAt: '2026-10-20T10:00:00.000Z',
                  metadata: {
                    kind: 'reel',
                    title: 'Withdrawn CI fixture',
                    summary: 'HTTP fixture only',
                    language: 'en',
                  },
                  availability: 'withdrawn',
                },
              ]
            : [],
        },
      });
      return;
    }
    if (path === '/v1/experience/keep/read') {
      const target = body.target as { assetId: string; assetRevision: number };
      await route.fulfill({
        json: {
          version: 'keep-place.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          target,
          status: saved ? 'saved_unavailable' : 'not_saved',
          ...(saved ? { entry: { ...target, savedEntryId: id(992) } } : {}),
        },
      });
      return;
    }
    if (path === '/v1/experience/keep/remove') {
      commands.push({ path, body });
      saved = false;
      await route.fulfill({
        json: {
          version: 'keep-remove.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          commandId: body.commandId,
          recordedAt: '2026-10-22T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.entry.remove',
          entry: body.entry,
        },
      });
      return;
    }
    if (path === '/v1/observations/batch') {
      const events = body.events as { eventId: string }[];
      await route.fulfill({
        json: {
          accepted: events.length,
          duplicates: 0,
          rejected: 0,
          results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
          revision: 1,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  return { commands };
}

test('Explore activates once per offer; browser Back restores the retained Scroll without another lineage command; Keep removes withdrawn references', async ({
  page,
}) => {
  const { commands } = await encounterFixture(page, 'scroll');
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByRole('button', { name: 'Next subject', exact: true }).last().click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 2' })).toBeVisible();
  expect(commands.map((call) => call.path)).toEqual([
    '/v1/experience/open',
    '/v1/experience/activate',
    '/v1/experience/navigate',
    '/v1/experience/activate',
  ]);
  const count = commands.length;
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  expect(commands).toHaveLength(count);
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('heading', { name: 'Your path', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Your path', exact: true })).not.toBeVisible();
  expect(commands).toHaveLength(count);
  await page.getByRole('link', { name: 'Keep', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Withdrawn CI fixture' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open saved encounter' })).toHaveCount(0);
  // Freeze authored test time before the grace starts, so browser/network assertion latency
  // cannot consume any of the exact 4,999 ms + 1 ms boundary below.
  await page.clock.install({ time: new Date('2026-10-22T06:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-10-22T06:00:01.000Z'));
  await page.getByRole('button', { name: 'Remove from Keep' }).click();
  await expect(page.getByRole('button', { name: 'Undo removal' })).toBeVisible();
  expect(commands.filter((call) => call.path.endsWith('/keep/remove'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo removal' }).click();
  await page.clock.fastForward(5000);
  expect(commands.filter((call) => call.path.endsWith('/keep/remove'))).toHaveLength(0);
  await expect(page.getByRole('heading', { name: 'Withdrawn CI fixture' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove from Keep' }).click();
  await expect(page.getByRole('button', { name: 'Undo removal' })).toBeVisible();
  await page.clock.fastForward(4999);
  expect(commands.filter((call) => call.path.endsWith('/keep/remove'))).toHaveLength(0);
  await page.clock.fastForward(1);
  await expect(page.getByText('Nothing kept yet', { exact: true })).toBeVisible();
  expect(commands.at(-1)?.path).toBe('/v1/experience/keep/remove');
  expect(commands.at(-1)?.body).toEqual({
    version: 'keep-remove.v1',
    commandId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    entry: { assetId: id(990), assetRevision: 2, savedEntryId: id(992) },
  });
  expect(commands.filter((call) => call.path === '/v1/actions')).toHaveLength(0);
});

// The actual ReelPlayer stage and sibling controls are used. This fixture intentionally makes no decoded-playback claim.
test('the full Reel stage commits vertical and related swipes; dragging a player button never navigates', async ({
  page,
}) => {
  const { commands } = await encounterFixture(page, 'reel');
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 404, body: 'CI gesture fixture only' }),
  );
  await page.goto('/explore');
  const stage = page.getByTestId('reel-navigation-stage');
  await expect(stage).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  const before = commands.length;
  const button = await page.getByRole('button', { name: 'Back 10s' }).boundingBox();
  if (!button) throw new Error('Actual player control is visible');
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(button.x + button.width / 2, button.y - 90, { steps: 6 });
  await page.mouse.up();
  expect(commands).toHaveLength(before);
  const first = await stage.boundingBox();
  if (!first) throw new Error('Actual Reel video stage is visible');
  await page.mouse.move(first.x + first.width / 2, first.y + first.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height * 0.75 - 100, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => commands.filter((call) => call.path.endsWith('/navigate')).length).toBe(1);
  expect(commands.filter((call) => call.path.endsWith('/navigate'))[0]?.body.intent).toEqual({
    mode: 'vertical',
    direction: 'next',
  });
  await expect.poll(() => commands.filter((call) => call.path.endsWith('/activate')).length).toBe(2);
  // Activation arriving at the fixture server precedes context/grant loading and the next surface commit.
  await expect(page.getByText('CI encounter fixture 2', { exact: true }).last()).toBeVisible();
  await expect(stage).toBeVisible();
  const second = await stage.boundingBox();
  if (!second) throw new Error('Next actual Reel stage is visible');
  await page.mouse.move(second.x + second.width * 0.7, second.y + second.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width * 0.7 - 100, second.y + second.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => commands.filter((call) => call.path.endsWith('/navigate')).length).toBe(2);
  expect(commands.filter((call) => call.path.endsWith('/navigate'))[1]?.body.intent).toEqual({
    mode: 'related',
    expectedContinuation: { linkId: id(801), assetId: id(302), assetRevision: document.revision },
  });
});
