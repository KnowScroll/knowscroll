import scrollDocument from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { expect, test } from '@playwright/test';
import { fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
/** Production-export consumer over authored HTTP fixtures. No established world/provider acceptance. */
test('authoritative map/outline/travel and browser Back keep camera private and perform reads only', async ({
  page,
}) => {
  const world = sceneFixture(),
    calls: string[] = [];
  const reads = new Set([
    '/v1/universe/geography/read',
    '/v1/universe/geography/deltas/read',
    '/v1/universe/scenes/manifest/read',
    '/v1/universe/scenes/chunks/read',
    '/v1/experience/region/preview',
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    // Fail at the actual HTTP boundary; unrelated bodyless requests are never draft fixtures.
    expect({ method: route.request().method(), path }).toEqual({ method: 'POST', path: expect.any(String) });
    expect(reads.has(path)).toBe(true);
    const body: unknown = route.request().postDataJSON();
    expect(body !== null && typeof body === 'object' && !Array.isArray(body)).toBe(true);
    return route.fulfill({
      json: path.endsWith('/region/preview')
        ? {
            ...(body as Record<string, unknown>),
            status: 'unavailable',
            reason: 'no_eligible_content',
            scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
            geographyRevision: 3,
            recordedAt: '2026-10-22T00:00:00.000Z',
          }
        : world.reply(path, body as Record<string, unknown>),
    });
  });
  await page.goto('/universe');
  await expect(page.getByRole('button', { name: 'Focus CI system 0, system' })).toBeVisible();
  await page.getByRole('button', { name: 'Focus CI system 0, system' }).click();
  await page.getByRole('button', { name: 'Focus CI planet 2, planet' }).click();
  await expect(page.getByRole('button', { name: 'Travel to CI planet 3' })).toBeVisible();
  await page.getByRole('button', { name: 'Travel to CI planet 3' }).click();
  await expect(page.getByRole('heading', { name: 'CI planet 3', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'CI planet 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'CI region 4 · region', exact: true }).click();
  await page.getByRole('button', { name: 'Place details', exact: true }).click();
  await expect(page.getByText('Encounters from this place aren’t available.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls.every((path) => reads.has(path))).toBe(true);
  expect(calls.filter((path) => path.endsWith('/region/preview'))).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Focus CI region 4, region', exact: true })).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toMatch(/objectId|frame|seed|0199a000/);
  // Talk is an unmounted placeholder; this isolates tab lifetime from Keep's separate Saved reads.
  await page.getByRole('link', { name: 'Talk', exact: true }).click();
  await page.getByRole('link', { name: 'Universe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CI region 4', exact: true })).toBeVisible();
  expect(calls.every((path) => reads.has(path))).toBe(true);
});

test('canonical region card opens displayed A through actual activation, then Back restores exact private map/focus and parks real Scroll place', async ({
  page,
}) => {
  const world = sceneFixture(),
    id = fixtureId;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const assetId = id(500),
    sessionId = id(501),
    offerId = id(502),
    exposureId = id(503),
    decisionId = id(504);
  const metadata = {
    kind: 'scroll',
    title: 'CI canonical region encounter',
    summary: 'Authored fixture only; no live approved mapping.',
    language: 'en',
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    let value: unknown;
    if (path.startsWith('/v1/universe/')) value = world.reply(path, body);
    else if (path.endsWith('/region/preview'))
      value = {
        ...body,
        scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
        recordedAt: '2026-10-22T00:00:00.000Z',
        geographyRevision: 3,
        status: 'available',
        encounter: { assetId, assetRevision: 1, metadata },
      };
    else if (path.endsWith('/region/open')) {
      expect(Object.keys(body).sort()).toEqual(['capabilities', 'commandId', 'expectedEncounter', 'target', 'version']);
      expect(body.expectedEncounter).toEqual({ assetId, assetRevision: 1 });
      value = {
        version: body.version,
        target: body.target,
        expectedEncounter: body.expectedEncounter,
        capabilities: body.capabilities,
        universeId: fixtureAccount.universeId,
        privacyEpoch: 1,
        outcome: {
          commandId: body.commandId,
          sessionId,
          intentRevision: 1,
          revision: 41,
          decisionId,
          replayed: false,
          status: 'ready',
          offer: {
            offerId,
            decisionId,
            assetId,
            assetRevision: 1,
            explanationUnitId: 'fixture-eu-spring-neap',
            metadata,
            relation: { kind: 'discovery' },
            variants: [{ kind: 'reel', status: 'unavailable' }],
          },
          bufferedOffers: [],
        },
      };
    } else if (path.endsWith('/activate'))
      value = {
        commandId: body.commandId,
        sessionId,
        intentRevision: 1,
        offerId,
        exposureId,
        assetId,
        assetRevision: 1,
        kind: 'scroll',
        activatedAt: '2026-10-22T00:00:00.000Z',
        revision: 42,
        replayed: false,
      };
    else if (path.endsWith('/context'))
      value = {
        exposureId,
        assetId,
        assetRevision: 1,
        revision: 42,
        session: { sessionId, intentRevision: 1 },
        actions: { saved: false, liked: false, hidden: false },
        variants: [{ kind: 'reel', status: 'unavailable' }],
        continuations: {
          seriesNext: { status: 'unavailable', reason: 'series_boundary' },
          seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
          related: { status: 'unavailable', reason: 'no_related_ready' },
        },
      };
    else if (path.endsWith('/document'))
      value = {
        exposureId,
        assetId,
        assetRevision: 1,
        document: { ...scrollDocument, assetId, title: metadata.title },
        degradedEssential: [],
      };
    else if (path.endsWith('/observations/batch')) {
      const events = body.events as { eventId: string }[];
      value = {
        accepted: events.length,
        duplicates: 0,
        rejected: 0,
        revision: 43,
        results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
      };
    } else throw new Error(`Unexpected region fixture request: ${path}`);
    await route.fulfill({ json: value });
  });
  await page.goto('/universe');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'CI region 4 · region', exact: true }).click();
  const map = page.getByTestId('universe-map');
  await map.focus();
  await page.keyboard.press('ArrowRight');
  const transforms = await map
    .locator('svg g[transform]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('transform')));
  expect(transforms.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Place details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'CI region 4', exact: true });
  await expect(dialog.getByRole('heading', { name: 'CI region 4', exact: true })).toBeFocused();
  await expect(dialog.getByRole('heading', { name: metadata.title })).toBeVisible();
  expect(calls.some((c) => /region\/open|activate|observations/.test(c.path))).toBe(false);
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: metadata.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  const article = page.getByTestId('scroll-article');
  await article.hover();
  await page.mouse.wheel(0, 420);
  await expect.poll(() => article.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CI region 4', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Focus CI region 4, region', exact: true })).toBeFocused();
  expect(
    await map.locator('svg g[transform]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('transform'))),
  ).toEqual(transforms);
  expect(calls.filter((c) => c.path.endsWith('/region/open'))).toHaveLength(1);
  expect(calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(1);
  expect(calls.some((c) => c.path === '/v1/experience/open')).toBe(false);
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toMatch(/objectId|frame|seed|0199a000/);
  const retained = await page.evaluate((ref) => {
    const key = Object.keys(localStorage).find((k) => k.endsWith(`encounter.resume.${ref}.1`));
    return key ? (JSON.parse(localStorage.getItem(key)!) as unknown) : undefined;
  }, assetId);
  expect(retained).toMatchObject({
    kind: 'scroll',
    value: { assetId, revision: 1, blockId: expect.any(String), offsetWithinBlock: expect.any(Number) },
  });
  expect((retained as { value: { offsetWithinBlock: number } }).value.offsetWithinBlock).toBeGreaterThanOrEqual(0);
});
