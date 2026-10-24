import { expect, test, type Page } from '@playwright/test';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { encounterFixture, id } from './encounter-fixture';

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
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'More', exact: true })).not.toBeVisible();
  expect(commands).toHaveLength(count);
  await page.getByRole('link', { name: 'Keep', exact: true }).click();
  await expect(page.getByText('Saved encounter', { exact: true })).toBeVisible();
  // A withdrawn reference is a card that cannot be opened.
  await expect(page.getByRole('button', { name: /^Saved encounter\. Reel\./ })).toBeDisabled();
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
  await expect(page.getByText('Saved encounter', { exact: true })).toBeVisible();
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
test('the full Reel stage commits vertical and related swipes; dragging an action button never navigates', async ({
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
  const button = await page.getByRole('button', { name: 'Share', exact: true }).boundingBox();
  if (!button) throw new Error('Actual action control is visible');
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
  await expect(page.getByText('Paged CI fixture 1', { exact: true })).toBeVisible();
  for (let start = 20; start < 160; start += 20) {
    await page.getByRole('button', { name: 'Next 20 saved encounters', exact: true }).click();
    await expect(page.getByText(`Paged CI fixture ${start + 1}`, { exact: true })).toBeVisible();
    await expect(page.getByTestId('saved-encounter-card')).toHaveCount(20);
    await expect(page.getByText('Paged CI fixture 1', { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Next 20 saved encounters', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous 20 saved encounters', exact: true }).click();
  await expect(page.getByText('Paged CI fixture 121', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reels', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(page.getByText('Nothing kept yet', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous 20 saved encounters', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Paged CI fixture 21', { exact: true })).toBeVisible();
  // Choosing the filter again starts a fresh traversal from the newest page.
  await page.getByRole('button', { name: 'Reels', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByText('Paged CI fixture 1', { exact: true })).toBeVisible();
  expect(
    requests.every(
      (url) => url.searchParams.get('pagination') === 'saved-page.v1' && url.searchParams.get('limit') === '20',
    ),
  ).toBe(true);
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
});

// Real exported geometry and hit targets over authored transport; no decoded/native playback claim.
/**
 * Resizes the window and waits until the Reel chrome has been laid out for that size. The stage
 * reflows at once in CSS, but the chrome is positioned from the window size in a later React commit,
 * so measuring right after `setViewportSize` can see the old layout. The chrome names the size it
 * was laid out for in its test id; there is nothing to sleep on.
 */
async function resizeReel(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await expect(page.getByTestId(`reel-chrome-${String(size.width)}x${String(size.height)}`)).toBeAttached();
}

test('the full-bleed Reel keeps every control reachable and the same video across phone, landscape and desktop bounds', async ({
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
  const controls = ['More options', 'Like', 'Save', 'Share', 'Ask about this', 'Mute'];
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 355, height: 767 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await resizeReel(page, viewport);
    // The stage fills the Reel column: the whole page on a phone, a column of at most 480 px on a wide screen.
    const stage = await page.getByTestId('reel-video-stage').boundingBox();
    if (!stage) throw new Error('The Reel stage is measurable');
    expect(stage.width).toBeLessThanOrEqual(Math.min(viewport.width, 480) + 1);
    // From 1024 px the Reel is a card with its controls around it (D01), a little shorter than the window.
    const desktop = viewport.width >= 1024;
    expect(stage.height).toBeGreaterThan(viewport.height * (desktop ? 0.7 : 0.8));
    expect(
      await page.getByTestId('reel-video-stage').evaluate((node) => {
        const observed = window as typeof window & { __ksLayoutObserved?: Element[] };
        return (
          observed.__ksLayoutObserved?.includes(node) &&
          !observed.__ksLayoutObserved?.some((n) => n.getAttribute('data-testid') === 'reel-player')
        );
      }),
    ).toBe(true);
    for (const name of controls) {
      const control = page.getByRole('button', { name, exact: true });
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
        `${name} is the topmost element at its centre in ${String(viewport.width)}×${String(viewport.height)}`,
      ).toBe(true);
    }
    // The full-bleed layout keeps its parts in order and apart: top bar, then the action rail, then the
    // edge tab; the title above the progress row; and nothing drawn over anything else.
    const where = `${String(viewport.width)}×${String(viewport.height)}`;
    const layoutProblems = async () => {
      const rect = async (locator: ReturnType<Page['locator']>) => {
        const box = await locator.boundingBox();
        if (!box) return { left: 0, top: 0, right: 0, bottom: 0 };
        return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
      };
      const switchRect = await rect(page.getByRole('radiogroup', { name: 'Format of this explanation' }));
      const moreRect = await rect(page.getByRole('button', { name: 'More options', exact: true }));
      const parts = {
        rail: await rect(page.getByRole('group', { name: 'Actions' })),
        tab: await rect(
          page
            .getByTestId('encounter-continuation-edges')
            .getByRole('button', { name: /^Another related explanation/ }),
        ),
        title: await rect(page.getByTestId('encounter-reel-caption')),
        progress: await rect(page.getByLabel('Reel progress')),
        mute: await rect(page.getByRole('button', { name: 'Mute', exact: true })),
      };
      const problems: string[] = [];
      if (Math.max(switchRect.bottom, moreRect.bottom) > parts.rail.top + 1) problems.push('top bar above the rail');
      if (parts.rail.bottom > parts.tab.top + 1) problems.push('rail above the edge tab');
      if (parts.title.bottom > parts.progress.top + 1) problems.push('title above the progress row');
      const apart = (first: typeof parts.rail, second: typeof parts.rail) =>
        first.right <= second.left + 1 ||
        second.right <= first.left + 1 ||
        first.bottom <= second.top + 1 ||
        second.bottom <= first.top + 1;
      for (const [first, second] of [
        ['rail', 'title'],
        ['rail', 'mute'],
        ['rail', 'progress'],
        ['tab', 'title'],
        ['tab', 'mute'],
        ['tab', 'progress'],
      ] as const)
        if (!apart(parts[first], parts[second])) problems.push(`${first} overlaps ${second}`);
      return problems;
    };
    if (desktop) {
      // D01: Previous subject and the switch above the card, the actions beside it, Next subject and the keys below.
      const card = stage;
      const above = await page.getByRole('button', { name: 'Previous subject' }).boundingBox();
      const rail = await page.getByRole('group', { name: 'Actions' }).boundingBox();
      const below = await page.getByRole('button', { name: 'Next subject' }).boundingBox();
      if (!above || !rail || !below) throw new Error('The desktop frame draws its controls');
      expect(above.y + above.height).toBeLessThanOrEqual(card.y + 1);
      expect(rail.x).toBeGreaterThanOrEqual(card.x + card.width - 1);
      expect(below.y).toBeGreaterThanOrEqual(card.y + card.height - 1);
      await expect(page.getByTestId('encounter-continuation-edges')).toHaveCount(0);
    } else {
      expect(await layoutProblems(), `Reel layout at ${where}`).toEqual([]);
    }
    const switchBox = await page.getByRole('radiogroup', { name: 'Format of this explanation' }).boundingBox();
    if (!switchBox) throw new Error('The full format switch remains available');
    expect(switchBox.x).toBeGreaterThanOrEqual(0);
    expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(viewport.width + 1);
    await expect(page.getByRole('radio', { name: 'Scroll' })).toBeEnabled();
    expect(await page.locator('video').evaluate((node, original) => node === original, video)).toBe(true);
    expect(commands.filter((c) => /\/(open|activate|navigate)$/.test(c.path))).toHaveLength(lineage);
  }
  // Text-only browser enlargement exercises real wrapping/hit geometry. Actual Display textScale=2
  // semantics are separately checked by the native UI fixtures; this is not an OS setting claim.
  await resizeReel(page, { width: 355, height: 767 });
  await page.locator('[data-testid="encounter-explore"] [dir="auto"]').evaluateAll((nodes) => {
    for (const node of nodes)
      if (node instanceof HTMLElement) {
        const s = getComputedStyle(node);
        node.style.fontSize = `${parseFloat(s.fontSize) * 2}px`;
        node.style.lineHeight = `${parseFloat(s.lineHeight) * 2}px`;
      }
  });
  for (const name of ['Mute', 'More options', 'Share']) {
    const control = page.getByRole('button', { name, exact: true });
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
  // Underway the actions float; at the end card, which holds its own row, only that one is on screen.
  const actionRowsOnScreen = () =>
    page.evaluate(
      () =>
        [...globalThis.document.querySelectorAll('[aria-label="Actions"]')].filter((node) => {
          const r = node.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && r.width > 0;
        }).length,
    );
  await article.evaluate((node) => {
    node.scrollTop = 900;
  });
  await expect(page.getByTestId('encounter-floating-actions')).toBeVisible();
  await article.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.getByTestId('encounter-scroll-end')).toBeVisible();
  await expect(page.getByTestId('encounter-floating-actions')).toHaveCount(0);
  expect(await actionRowsOnScreen()).toBe(1);
});

test('a Scroll opened from the Reel by the format switch says where from, and the chip goes back to the Reel (E06)', async ({
  page,
}) => {
  await encounterFixture(page, 'reel', { series: true });
  const scrollOffer = {
    offerId: id(150),
    decisionId: id(250),
    assetId: id(500),
    assetRevision: document.revision,
    explanationUnitId: 'ci-fixture-0',
    metadata: {
      kind: 'scroll',
      title: 'CI encounter fixture 1, as a Scroll',
      summary: 'HTTP fixture only',
      language: 'en',
    },
    relation: { kind: 'format_variant' },
    variants: [{ kind: 'reel', status: 'ready', assetId: id(300), assetRevision: document.revision }],
  };
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/experience/navigate' && (body.intent as { mode?: string }).mode === 'variant')
      return route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(3),
          intentRevision: 2,
          revision: 2,
          decisionId: id(4),
          replayed: false,
          status: 'ready',
          offer: scrollOffer,
          bufferedOffers: [],
        },
      });
    if (path === '/v1/experience/activate' && (body.target as { offerId?: string }).offerId === scrollOffer.offerId)
      return route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(3),
          intentRevision: 2,
          offerId: scrollOffer.offerId,
          exposureId: id(450),
          assetId: scrollOffer.assetId,
          assetRevision: document.revision,
          kind: 'scroll',
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision: 2,
          replayed: false,
        },
      });
    if (path === `/v1/experience/exposures/${id(450)}/context`)
      return route.fulfill({
        json: {
          exposureId: id(450),
          assetId: scrollOffer.assetId,
          assetRevision: document.revision,
          revision: 2,
          session: { sessionId: id(3), intentRevision: 2 },
          actions: { saved: false, liked: false, hidden: false },
          variants: scrollOffer.variants,
          continuations: {
            seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
            seriesNext: { status: 'unavailable', reason: 'series_boundary' },
            related: { status: 'unavailable', reason: 'no_related_ready' },
          },
        },
      });
    if (path.endsWith(`${id(450)}/document`))
      return route.fulfill({
        json: {
          exposureId: id(450),
          assetId: scrollOffer.assetId,
          assetRevision: document.revision,
          document: { ...document, assetId: scrollOffer.assetId, title: scrollOffer.metadata.title },
          degradedEssential: [],
        },
      });
    return route.fallback();
  });
  await page.goto('/explore');
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByText('CI encounter fixture 1', { exact: true }).first()).toBeVisible();
  await page.getByRole('radio', { name: 'Scroll', exact: true }).first().click();
  const chip = page.getByRole('button', { name: /^From the Reel.*Back to Reel$/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByText('CI encounter fixture 1', { exact: true }).first()).toBeVisible();
  await expect(chip).toHaveCount(0);
});

test('V01: at 320 px the first-arrival hint stays clear of the action rail', async ({ page }) => {
  await encounterFixture(page, 'reel', { viewport: { width: 320, height: 640 } });
  await page.goto('/explore');
  const hint = page.getByRole('note', { name: 'How to move around' });
  await expect(hint).toBeVisible();
  const hintBox = await hint.boundingBox();
  if (!hintBox) throw new Error('The hint is measurable');
  for (const name of [/^Like/, /^Save/, /^Share/, /^Ask/]) {
    const box = await page.getByRole('button', { name }).first().boundingBox();
    if (!box) throw new Error(`The ${String(name)} button is measurable`);
    const across = Math.min(hintBox.x + hintBox.width, box.x + box.width) - Math.max(hintBox.x, box.x);
    const down = Math.min(hintBox.y + hintBox.height, box.y + box.height) - Math.max(hintBox.y, box.y);
    expect(across > 0 && down > 0, `${String(name)} is covered by the hint`).toBe(false);
  }
});
