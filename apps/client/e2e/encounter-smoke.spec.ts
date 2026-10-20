import { expect, test } from '@playwright/test';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import type { EncounterOffer, ExposureContextResponse } from '@knowscroll/contracts';

/** Actual production-export UI with explicitly labelled HTTP fixtures, not backend/provider acceptance. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
test('Explore activates once per offer; browser Back restores the retained Scroll without another lineage command; Keep removes withdrawn references', async ({
  page,
}) => {
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
      kind: 'scroll',
      title: `CI encounter fixture ${String(n + 1)}`,
      summary: 'HTTP fixture only',
      language: 'en',
    },
    relation: { kind: 'discovery' },
    variants: [{ kind: 'reel', status: 'unavailable' }],
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
          kind: 'scroll',
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
        variants: [{ kind: 'reel', status: 'unavailable' }],
        continuations: {
          seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
          seriesNext: { status: 'unavailable', reason: 'series_boundary' },
          related: { status: 'unavailable', reason: 'no_related_ready' },
        },
      };
      await route.fulfill({ json: context });
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
    if (path === '/v1/actions') {
      commands.push({ path, body });
      saved = false;
      await route.fulfill({
        json: {
          commandId: body.commandId,
          actionId: id(991),
          kind: 'unsave',
          assetId: id(990),
          assetRevision: 2,
          saved: false,
          changed: true,
          revision: 2,
          replayed: false,
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
  await expect(page.getByText('Your path', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Your path', { exact: true })).not.toBeVisible();
  expect(commands).toHaveLength(count);
  await page.getByRole('tab', { name: 'Keep' }).click();
  await expect(page.getByRole('heading', { name: 'Withdrawn CI fixture' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open saved encounter' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove from Keep' }).click();
  await expect(page.getByText('Nothing kept yet', { exact: true })).toBeVisible();
  expect(commands.at(-1)?.body).toMatchObject({ kind: 'unsave', target: { assetId: id(990), assetRevision: 2 } });
});
