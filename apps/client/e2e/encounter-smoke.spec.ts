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
    if (path === '/v1/privacy/recording/read') {
      await route.fulfill({
        json: {
          version: 'recording-policy.v1',
          ...body,
          scope: { accountId: id(1), privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
      return;
    }
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
      const url = new URL(request.url());
      await route.fulfill({
        json: {
          pagination: 'saved-page.v1',
          consistency: 'live',
          filter: url.searchParams.get('filter'),
          limit: 20,
          scope: { accountId: id(1), privacyEpoch: 1 },
          ...(url.searchParams.has('cursor') ? { requestCursor: url.searchParams.get('cursor') } : {}),
          continuation: { status: 'end' },
          revision: 1,
          items: saved
            ? [
                {
                  assetId: id(990),
                  assetRevision: 2,
                  savedAt: '2026-10-20T10:00:00.000Z',
                  savedEntryId: id(992),
                  kind: 'reel',
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
    if (path === '/v1/observations/recording-batch') {
      const events = body.events as { eventId: string }[];
      await route.fulfill({
        json: {
          version: 'observation-batch.v2',
          result: 'processed',
          recordingGeneration: body.recordingGeneration,
          currentGeneration: body.recordingGeneration,
          scope: { accountId: id(1), privacyEpoch: 1 },
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
  await expect(page.getByRole('heading', { name: 'Saved encounter' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Saved encounter' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove from Keep' }).click();
  await expect(page.getByRole('button', { name: 'Undo removal' })).toBeVisible();
  await page.clock.fastForward(4999);
  expect(commands.filter((call) => call.path.endsWith('/keep/remove'))).toHaveLength(0);
  await page.clock.fastForward(1);
  await expect.poll(() => commands.filter((call) => call.path.endsWith('/keep/remove')).length).toBe(1);
  expect(commands.at(-1)?.path).toBe('/v1/experience/keep/remove');
  expect(commands.at(-1)?.body).toEqual({
    version: 'keep-remove.v1',
    commandId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    recordingGeneration: 1,
    entry: { assetId: id(990), assetRevision: 2, savedEntryId: id(992) },
  });
  expect(commands.filter((call) => call.path === '/v1/actions')).toHaveLength(0);
  // The boundary above is frozen/exact. Let post-ACK TanStack zero-delay notifications and
  // the normal asynchronous browser render run before checking the authoritative list.
  await page.clock.resume();
  await expect(page.getByText('Nothing kept yet', { exact: true })).toBeVisible();
  expect(commands.filter((call) => call.path.endsWith('/keep/remove'))).toHaveLength(1);
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
  await page.getByRole('button', { name: 'Back 10s' }).scrollIntoViewIfNeeded();
  const button = await page.getByRole('button', { name: 'Back 10s' }).boundingBox();
  if (!button) throw new Error('Actual player control is visible');
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(button.x + button.width / 2, button.y - 90, { steps: 6 });
  await page.mouse.up();
  expect(commands).toHaveLength(before);
  await stage.scrollIntoViewIfNeeded();
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
  await stage.scrollIntoViewIfNeeded();
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

// Authored paged transport over the actual exported Keep UI. No live account/library data.
test('Keep traverses beyond one hundred items, revisits a page, resets filters and continues an empty live page', async ({
  page,
}) => {
  await encounterFixture(page, 'reel');
  const requests: URL[] = [];
  const cursorFor = (n: number) => `ksp1_${'a'.repeat(43)}${String(n).padStart(4, '0')}`;
  await page.route('**/v1/saved*', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const filter = url.searchParams.get('filter');
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? Number(cursor.slice(-4)) : 0;
    const empty = filter === 'reel' && !cursor;
    await route.fulfill({
      json: {
        pagination: 'saved-page.v1',
        consistency: 'live',
        scope: { accountId: id(1), privacyEpoch: 1 },
        filter,
        limit: 20,
        ...(cursor ? { requestCursor: cursor } : {}),
        revision: 2,
        items: empty
          ? []
          : Array.from({ length: 20 }, (_, offset) => ({
              assetId: id(2000 + start + offset),
              assetRevision: 1,
              savedEntryId: id(4000 + start + offset),
              savedAt: '2026-10-22T00:00:00.000Z',
              kind: 'reel',
              availability: 'available',
              metadata: {
                kind: 'reel',
                title: `Paged CI fixture ${start + offset + 1}`,
                summary: 'Authored paged fixture only',
                language: 'en',
              },
            })),
        continuation:
          start + 20 < (filter === 'reel' ? 40 : 160)
            ? { status: 'more', cursor: cursorFor(start + 20) }
            : { status: 'end' },
      },
    });
  });
  await page.route('**/v1/experience/keep/read', async (route) => {
    const { target } = route.request().postDataJSON() as { target: { assetId: string; assetRevision: number } };
    await route.fulfill({
      json: {
        version: 'keep-place.v1',
        scope: { accountId: id(1), privacyEpoch: 1 },
        target,
        status: 'available',
        entry: { ...target, savedEntryId: id(Number(target.assetId.slice(-12)) + 2000) },
        place: { status: 'none', placeRevision: 0 },
      },
    });
  });
  await page.goto('/saved');
  await expect(page.getByRole('heading', { name: 'Paged CI fixture 1', exact: true })).toBeVisible();
  for (let start = 20; start < 160; start += 20) {
    await page.getByRole('button', { name: 'Next 20 saved encounters', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Paged CI fixture ${start + 1}`, exact: true })).toBeVisible();
    await expect(page.getByTestId('saved-encounter-card')).toHaveCount(20);
    await expect(page.getByRole('heading', { name: 'Paged CI fixture 1', exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Next 20 saved encounters', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous 20 saved encounters', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paged CI fixture 121', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reels', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(page.getByText('Nothing kept yet', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous 20 saved encounters', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paged CI fixture 21', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Keep', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paged CI fixture 1', exact: true })).toBeVisible();
  expect(
    requests.every(
      (url) => url.searchParams.get('pagination') === 'saved-page.v1' && url.searchParams.get('limit') === '20',
    ),
  ).toBe(true);
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
});

// Real exported geometry and hit targets over authored transport; no decoded/native playback claim.
test('Reel controls reflow without overlap across actual phone, landscape and desktop bounds, retaining the same video', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const observed = window as typeof window & { __ksLayoutObserved?: Element[] };
    observed.__ksLayoutObserved = [];
    const NativeObserver = IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      override observe(target: Element) {
        if (target.getAttribute('data-testid')?.startsWith('reel-')) observed.__ksLayoutObserved?.push(target);
        super.observe(target);
      }
    };
  });
  const { commands } = await encounterFixture(page, 'reel');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 404, body: 'CI layout fixture only' }),
  );
  await page.goto('/explore');
  await expect(page.getByTestId('reel-player')).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  const video = await page.locator('video').elementHandle();
  if (!video) throw new Error('The actual expo-video web element must be mounted');
  const lineage = commands.filter((c) => /\/(open|activate|navigate)$/.test(c.path)).length;
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 355, height: 767 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() => page.getByTestId('reel-video-stage').evaluate((node) => node.getBoundingClientRect().width))
      .toBeGreaterThan(100);
    const geometry = await page.evaluate(() => {
      const rect = (id: string) => {
        const n = globalThis.document.querySelector(`[data-testid="${id}"]`);
        if (!n) throw new Error(`Missing actual layout ${id}`);
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        page: rect('encounter-page'),
        stage: rect('reel-video-stage'),
        controls: rect('reel-player-controls'),
        caption: rect('encounter-reel-caption'),
        navigation: rect('encounter-subject-navigation'),
        edges: rect('encounter-continuation-edges'),
      };
    });
    expect(geometry.stage.height).toBeGreaterThan(50);
    await expect
      .poll(() =>
        page.getByTestId('reel-video-stage').evaluate((node) => {
          const page = globalThis.document.querySelector('[data-testid="encounter-page"]')!.getBoundingClientRect();
          return node.getBoundingClientRect().height <= page.height / 2 + 1;
        }),
      )
      .toBe(true);
    expect(
      await page.getByTestId('reel-video-stage').evaluate((node) => {
        const observed = window as typeof window & { __ksLayoutObserved?: Element[] };
        return (
          observed.__ksLayoutObserved?.includes(node) &&
          !observed.__ksLayoutObserved?.some((n) => n.getAttribute('data-testid') === 'reel-player')
        );
      }),
    ).toBe(true);
    // Align the actual primary playback control, then prove reachability and visibility together.
    const primary = page.getByTestId('reel-player-controls').getByRole('button', { name: /^(Play|Retry|Pause)$/ });
    const primaryHandle = await primary.elementHandle();
    if (!primaryHandle) throw new Error('The actual primary playback control must be mounted');
    await page.getByTestId('encounter-page-scroll').evaluate((node, control) => {
      node.scrollTop += control.getBoundingClientRect().bottom - (node.getBoundingClientRect().bottom - 8);
    }, primaryHandle);
    const usable = await primary.evaluate((node) => {
      const control = node.getBoundingClientRect(),
        stage = globalThis.document.querySelector('[data-testid="reel-video-stage"]')!.getBoundingClientRect(),
        page = globalThis.document.querySelector('[data-testid="encounter-page"]')!.getBoundingClientRect();
      const left = Math.max(0, page.left),
        right = Math.min(innerWidth, page.right),
        top = Math.max(0, page.top),
        bottom = Math.min(innerHeight, page.bottom);
      const area =
        Math.max(0, Math.min(stage.right, right) - Math.max(stage.left, left)) *
        Math.max(0, Math.min(stage.bottom, bottom) - Math.max(stage.top, top));
      return {
        stageVisibleFraction: area / (stage.width * stage.height),
        insidePageAndViewport:
          control.left >= left - 1 &&
          control.right <= right + 1 &&
          control.top >= top - 1 &&
          control.bottom <= bottom + 1,
        targetSize: control.width >= 44 && control.height >= 44,
        hit: node.contains(
          globalThis.document.elementFromPoint(control.left + control.width / 2, control.top + control.height / 2),
        ),
      };
    });
    expect(usable).toMatchObject({ insidePageAndViewport: true, targetSize: true, hit: true });
    expect(usable.stageVisibleFraction).toBeGreaterThanOrEqual(0.5);
    expect(geometry.stage.bottom).toBeLessThanOrEqual(geometry.controls.top + 1);
    expect(geometry.controls.bottom).toBeLessThanOrEqual(geometry.caption.top + 1);
    expect(geometry.caption.bottom).toBeLessThanOrEqual(geometry.navigation.top + 1);
    expect(geometry.edges.top).toBeGreaterThanOrEqual(geometry.stage.top);
    expect(geometry.edges.bottom).toBeLessThanOrEqual(geometry.stage.bottom);
    for (const name of ['Back 10s', 'Forward 10s', 'Mute', 'Previous subject', 'Next subject', 'Keep this place']) {
      const control = page.getByRole('button', { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      if (!box) throw new Error(`Missing reachable ${name}`);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(
        await control.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = globalThis.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit !== null && node.contains(hit);
        }),
      ).toBe(true);
    }
    const unavailable = page.getByRole('radio', { name: 'Scroll · unavailable' });
    await unavailable.scrollIntoViewIfNeeded();
    const switchBox = await page.getByRole('radiogroup', { name: 'Format of this explanation' }).boundingBox();
    if (!switchBox) throw new Error('The full format switch remains available');
    expect(switchBox.x).toBeGreaterThanOrEqual(0);
    expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(viewport.width + 1);
    await expect(unavailable).toBeDisabled();
    expect(await page.locator('video').evaluate((node, original) => node === original, video)).toBe(true);
    expect(commands.filter((c) => /\/(open|activate|navigate)$/.test(c.path))).toHaveLength(lineage);
  }
  // Text-only browser enlargement exercises real wrapping/hit geometry. Actual Display textScale=2
  // semantics are separately checked by the native UI fixtures; this is not an OS setting claim.
  await page.setViewportSize({ width: 355, height: 767 });
  await page.locator('[data-testid="encounter-explore"] [dir="auto"]').evaluateAll((nodes) => {
    for (const node of nodes)
      if (node instanceof HTMLElement) {
        const s = getComputedStyle(node);
        node.style.fontSize = `${parseFloat(s.fontSize) * 2}px`;
        node.style.lineHeight = `${parseFloat(s.lineHeight) * 2}px`;
      }
  });
  for (const name of ['Mute', 'Next subject', 'Keep this place']) {
    const control = page.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    expect(
      await control.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.left >= 0 &&
          r.right <= innerWidth + 1 &&
          r.height >= 44 &&
          node.contains(globalThis.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
        );
      }),
    ).toBe(true);
  }
  expect(await page.locator('video').evaluate((node, original) => node === original, video)).toBe(true);
  expect(commands.filter((c) => /\/(open|activate|navigate)$/.test(c.path))).toHaveLength(lineage);
});

test('the narrow Scroll keeps its own bounded reading viewport and vertical reading never navigates', async ({
  page,
}) => {
  const { commands } = await encounterFixture(page, 'scroll');
  await page.setViewportSize({ width: 355, height: 767 });
  await page.goto('/explore');
  await page.getByRole('button', { name: 'Got it' }).click();
  const article = page.getByTestId('scroll-article');
  await expect(article).toBeVisible();
  const before = commands.length;
  const reading = await article.evaluate((node) => {
    node.scrollTop = 1000;
    return { height: node.clientHeight, content: node.scrollHeight };
  });
  expect(reading.height).toBeGreaterThan(100);
  expect(reading.content).toBeGreaterThan(reading.height);
  await expect.poll(() => article.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(commands).toHaveLength(before);
  const pageBox = await page.getByTestId('encounter-page').boundingBox();
  const articleBox = await article.boundingBox();
  if (!pageBox || !articleBox) throw new Error('The real reading viewport is measurable');
  expect(articleBox.y).toBeGreaterThanOrEqual(pageBox.y);
  expect(articleBox.y + articleBox.height).toBeLessThanOrEqual(pageBox.y + pageBox.height + 1);
});
