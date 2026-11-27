import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { shot, VOYAGE_READS } from './voyage-fixture';

/**
 * A friend's universe (U06) in the production export, over an authored HTTP fixture (the friend and their
 * systems are made up for CI): one cream bar with Leave first, the options behind the friend's initial, the one
 * lock chip at the bottom, and the primary navigation kept with Universe current, at a phone and a desktop width.
 */
const shots = process.env['KS_SHOT_DIR'];

interface FriendSystem {
  readonly publicSystemId: string;
  readonly label: string;
  readonly planets: readonly { publicPlanetId: string; label: string }[];
}

const ravisSystems: readonly FriendSystem[] = [
  {
    publicSystemId: fixtureId(200),
    label: 'Machine learning',
    planets: [{ publicPlanetId: fixtureId(201), label: 'Inference' }],
  },
  {
    publicSystemId: fixtureId(210),
    label: 'Baking',
    planets: [{ publicPlanetId: fixtureId(211), label: 'Bread' }],
  },
];

/**
 * Two of the friend's four systems carry names the fixture's own Universe has ("CI system 0" and "CI system 2"), written
 * with other case and an accent: the comparison folds both. The other two are names it does not have.
 */
const sharedWithMe: readonly FriendSystem[] = [
  ravisSystems[0]!,
  {
    publicSystemId: fixtureId(220),
    label: 'ci SYSTEM 0',
    planets: [{ publicPlanetId: fixtureId(221), label: 'Orbit' }],
  },
  ravisSystems[1]!,
  {
    publicSystemId: fixtureId(230),
    label: 'Cí system 2',
    planets: [{ publicPlanetId: fixtureId(231), label: 'Tides' }],
  },
];

const visitAnswer = (body: Record<string, unknown>, systems: readonly FriendSystem[] = ravisSystems) => ({
  version: 'sharing.v1',
  scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
  target: body['target'],
  capabilities: body['capabilities'],
  status: 'available',
  owner: { kind: 'person', personId: fixtureId(11), handle: 'fixture.ravi', displayName: 'Ravi fixture' },
  authority: { pairRevision: 3, publishedProjectionRevision: 1 },
  projection: {
    presentation: 'list.v1',
    systems,
  },
});

interface VisitOptions {
  /** "Try the new Universe" (Settings → Accessibility) draws a friend's Universe in the new look too. */
  readonly trial?: boolean;
  /** The app's appearance, as Settings sets it. */
  readonly appearance?: 'light' | 'dark';
  /** What the friend shares; two names of it are names of the person's own systems ({@link sharedWithMe}). */
  readonly systems?: readonly FriendSystem[];
  /** The person's own Universe (three authored systems) answers the reads a visit makes to compare names. */
  readonly own?: boolean;
  /** Every `/v1` path the page sends, in order. */
  readonly paths?: string[];
  /** Every `/v1` path whose answer the page has received, in order: what a test waits on before it asserts an absence. */
  readonly answered?: string[];
}

async function openVisit(page: Page, size: { width: number; height: number }, options: VisitOptions = {}) {
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const preferences = {
    ...(options.trial === true ? { universeTrial: true } : {}),
    ...(options.appearance ? { appearance: options.appearance } : {}),
  };
  if (Object.keys(preferences).length > 0)
    await page.addInitScript(
      (stored) => window.localStorage.setItem('ks.device.preferences', stored),
      JSON.stringify(preferences),
    );
  const world = sceneFixture(5, 0, 3, 2);
  const answered = options.answered;
  if (answered) page.on('response', (response) => answered.push(new URL(response.url()).pathname));
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    options.paths?.push(path);
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          ...body,
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, fixtureAccount.accountId) });
    if (path === '/v1/social/visits/read') return route.fulfill({ json: visitAnswer(body, options.systems) });
    if (options.own === true && VOYAGE_READS.has(path)) return route.fulfill({ json: world.reply(path, body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/visit/fixture.ravi');
  await expect(page.getByTestId('visitor-bar')).toBeVisible({ timeout: 60_000 });
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    serious.map((violation) => ({ rule: violation.id, nodes: violation.nodes.map((node) => node.target.join(' ')) })),
  ).toEqual([]);
}

test('a phone: one bar with Leave first, the options behind the initial, one lock chip, and the tab bar kept', async ({
  page,
}) => {
  await openVisit(page, { width: 390, height: 844 });
  const bar = page.getByTestId('visitor-bar');
  await expect(bar).toContainText('Visiting Ravi fixture’s universe');
  await expect(bar).toContainText('Only what Ravi fixture shares');
  // Leave comes before the initial, to the eye and in the tab order.
  const leave = page.getByTestId('visit-leave');
  const initial = page.getByTestId('visit-options');
  expect((await leave.boundingBox())!.x).toBeLessThan((await initial.boundingBox())!.x);
  await leave.focus();
  await page.keyboard.press('Tab');
  await expect(initial).toBeFocused();
  // Report is not on the map until the options are opened.
  await expect(page.getByRole('button', { name: /^Report/ })).toHaveCount(0);
  await initial.click();
  await expect(page.getByRole('button', { name: 'Report Ravi fixture' })).toBeVisible();
  await initial.click();
  // The primary navigation stays, with Universe current.
  await expect(page.getByRole('link', { name: 'Universe', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page.getByTestId('visit-private-parts')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/visit-phone.png` });
  await expectNoSeriousViolations(page);
});

test('a desktop: the rail is kept with Universe current', async ({ page }) => {
  await openVisit(page, { width: 1440, height: 900 });
  await expect(page.getByRole('link', { name: 'Universe', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Keep', exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/visit-desktop.png` });
  await expectNoSeriousViolations(page);
});

test('a friend’s universe in the new look: their systems and planets, every continent in colour, nothing on a planet named', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openVisit(page, { width: 390, height: 844 }, { trial: true });
  await expect(page.getByTestId('voyage-stage')).toBeVisible({ timeout: 60_000 });
  const system = page.getByRole('button', { name: 'Machine learning, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await system.click();
  const planet = page.getByRole('button', { name: 'Inference, a planet', exact: true });
  await expect(planet).toBeVisible({ timeout: 30_000 });
  await planet.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inference', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // A visit shares no regions: the globe is drawn, but no region is named, tappable or read out.
  await page.waitForTimeout(2000);
  await expect(page.getByRole('button', { name: /, a region$/ })).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/visit-new-look-planet-390x844.png` });
  await expectNoSeriousViolations(page);
});

/** The chip keeps one accessible name; its pressed state says whether it is on, and its words change with it. */
const inCommon = (page: Page) => page.getByRole('button', { name: 'What we have in common', exact: true });

/** Two frames of the page have run since the last answer arrived, so what the answer changes is on screen. */
const settled = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test('a friend’s universe in the new look: “What we have in common” marks the systems you share, and starts off', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const paths: string[] = [];
  await openVisit(page, { width: 390, height: 844 }, { trial: true, own: true, systems: sharedWithMe, paths });
  await expect(page.getByTestId('voyage-stage')).toBeVisible({ timeout: 60_000 });
  const plain = page.getByRole('button', { name: 'Machine learning, a system', exact: true });
  await expect(plain).toBeVisible({ timeout: 60_000 });

  // It is off when you arrive: the chip says what it does, and nothing is dimmed or marked.
  const off = inCommon(page);
  await expect(off).toBeVisible({ timeout: 30_000 });
  await expect(off).toHaveAttribute('aria-pressed', 'false');
  await expect(off).toContainText('What we have in common');
  await expect(page.getByTestId('voyage-common-sky')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /you have this too/ })).toHaveCount(0);
  // react-native-web ignores `hitSlop`: the pill itself is the 48 px target.
  expect((await off.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await shot(page, 'visit-common-off-390x844');

  // It takes the keyboard like any button.
  await off.focus();
  await expect(off).toBeFocused();
  await page.keyboard.press('Enter');
  const on = inCommon(page);
  await expect(on).toHaveAttribute('aria-pressed', 'true');
  await expect(on).toContainText('Showing what you share');
  await expect(page.getByTestId('voyage-common-sky')).toBeVisible();
  // Exactly the shared systems are ringed, and the names of the others keep 0.4 of their light.
  for (const shared of [fixtureId(220), fixtureId(230)]) {
    await expect(page.getByTestId(`voyage-common-ring-${shared}`)).toHaveCount(1);
    await expect(page.getByTestId(`voyage-name-${shared}`)).toHaveCSS('opacity', '1');
  }
  for (const unshared of [fixtureId(200), fixtureId(210)]) {
    await expect(page.getByTestId(`voyage-common-ring-${unshared}`)).toHaveCount(0);
    await expect(page.getByTestId(`voyage-name-${unshared}`)).toHaveCSS('opacity', '0.4');
  }
  await expect(page.locator('[data-testid^="voyage-common-ring-"]')).toHaveCount(2);
  // The shared systems say so; the others do not. The canvas stays hidden: these buttons are how a screen reader knows.
  await expect(
    page.getByRole('button', { name: 'ci SYSTEM 0, a system, you have this too', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Cí system 2, a system, you have this too', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Machine learning|Baking), a system$/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /you have this too/ })).toHaveCount(2);
  await expect(page.locator('canvas').first()).toHaveAttribute('aria-hidden', 'true');
  await shot(page, 'visit-common-on-390x844');
  await expectNoSeriousViolations(page);

  // Off again: everything is as it was.
  await on.click();
  await expect(inCommon(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('voyage-common-sky')).toHaveCount(0);
  await expect(page.locator('[data-testid^="voyage-name-"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /you have this too/ })).toHaveCount(0);

  // Switched on, a shared system still opens as one; below the whole universe the chip is not there.
  await inCommon(page).click();
  await page.getByRole('button', { name: 'ci SYSTEM 0, a system, you have this too', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Orbit, a planet', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(inCommon(page)).toHaveCount(0);
  await expect(page.getByTestId('voyage-common-sky')).toHaveCount(0);

  // Knowing your own names took one read of your own map, as the Universe tab makes it (the sky, then its three systems
  // whole), and looking sent nothing else: no write, no second read.
  const tally: Record<string, number> = {};
  for (const path of paths.filter((path) => !isInboxPath(path))) tally[path] = (tally[path] ?? 0) + 1;
  const reads = Object.keys(tally).filter((path) => path !== '/v1/social/visits/read');
  expect(reads.filter((path) => path !== '/v1/privacy/recording/read' && !VOYAGE_READS.has(path))).toEqual([]);
  for (const once of ['sky', 'manifest', 'geography'])
    expect(
      Object.entries(tally).filter(([path]) => path.includes(`/${once}/read`)),
      once,
    ).toEqual([[expect.stringContaining(`/${once}/read`), 1]]);
  expect(tally['/v1/universe/scenes/chunks/read']).toBeLessThanOrEqual(3);
});

test('a friend’s universe in the new look at a desktop width: the chip and the dim', async ({ page }) => {
  test.setTimeout(180_000);
  await openVisit(page, { width: 1440, height: 900 }, { trial: true, own: true, systems: sharedWithMe });
  await expect(page.getByRole('button', { name: 'Machine learning, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await inCommon(page).click();
  await expect(inCommon(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /you have this too/ })).toHaveCount(2);
  await expect(page.getByTestId('voyage-common-sky')).toBeVisible();
  await shot(page, 'visit-common-on-1440x900');
  await inCommon(page).click();
  await shot(page, 'visit-common-off-1440x900');
});

test('a friend with none of your names: the chip says so plainly and dims nothing', async ({ page }) => {
  test.setTimeout(180_000);
  await openVisit(page, { width: 390, height: 844 }, { trial: true, own: true });
  await expect(page.getByRole('button', { name: 'Machine learning, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await inCommon(page).click();
  await expect(inCommon(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(inCommon(page)).toContainText('Nothing in common yet');
  await expect(page.getByTestId('voyage-common-sky')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /you have this too/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Machine learning|Baking), a system$/ })).toHaveCount(2);
});

test('no chip when your own universe is not in hand to compare with', async ({ page }) => {
  test.setTimeout(180_000);
  // The own reads are not answered (404): nothing to compare, so no chip.
  const answered: string[] = [];
  await openVisit(page, { width: 390, height: 844 }, { trial: true, systems: sharedWithMe, answered });
  await expect(page.getByRole('button', { name: 'Machine learning, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  // The refusal of your own map has come back, and the screen has drawn since: still no chip.
  await expect.poll(() => answered.includes('/v1/universe/scenes/sky/read'), { timeout: 30_000 }).toBe(true);
  await settled(page);
  await expect(page.getByTestId('visit-in-common')).toHaveCount(0);
});

test('with the switch off the old map has no chip and the visit reads nothing of your own universe', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const paths: string[] = [];
  const answered: string[] = [];
  await openVisit(page, { width: 390, height: 844 }, { own: true, systems: sharedWithMe, paths, answered });
  await expect(page.getByTestId('visitor-bar')).toBeVisible({ timeout: 60_000 });
  // The friend's list has been answered and drawn: what the new look would have asked for by now has been asked.
  await expect.poll(() => answered.includes('/v1/social/visits/read'), { timeout: 30_000 }).toBe(true);
  await settled(page);
  await expect(page.getByTestId('visit-in-common')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /What we have in common|Showing what you share/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /you have this too/ })).toHaveCount(0);
  expect(paths.filter((path) => path.startsWith('/v1/universe/'))).toEqual([]);
});

/**
 * What the visit paints, in page order, from the element that carries the screen's appearance: the colour of each
 * visible piece of text, each background that is not transparent, each border that has a width, and each SVG shape's
 * fill and stroke. The words of the frame-rate readout change with time, so it is left out.
 */
const paintedColours = (page: Page): Promise<string[]> =>
  page.getByTestId('voyage-stage').evaluate((stage) => {
    const screen = stage.closest('[data-ks-appearance]') ?? stage;
    const painted: string[] = [];
    for (const element of screen.querySelectorAll<HTMLElement | SVGElement>('*')) {
      if (element.closest('[data-testid="universe-frame-rate"]')) continue;
      if (!element.checkVisibility() || element.getBoundingClientRect().width === 0) continue;
      const style = getComputedStyle(element);
      const name = element.tagName.toLowerCase();
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim());
      if (ownText) painted.push(`${name} "${(element.textContent ?? '').trim().slice(0, 24)}" text ${style.color}`);
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') painted.push(`${name} background ${style.backgroundColor}`);
      if (parseFloat(style.borderTopWidth) > 0) painted.push(`${name} border ${style.borderTopColor}`);
      if (element instanceof SVGElement && name !== 'svg')
        painted.push(`${name} fill ${style.fill} stroke ${style.stroke}`);
    }
    return painted;
  });

test('a friend’s universe in the new look looks the same in Light and in Dark (D-400)', async ({ browser }) => {
  test.setTimeout(240_000);
  const seen: Record<string, string[][]> = {};
  for (const appearance of ['light', 'dark'] as const) {
    const page = await browser.newPage();
    await openVisit(page, { width: 390, height: 844 }, { trial: true, own: true, systems: sharedWithMe, appearance });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
      .toBe(appearance);
    const stops: string[][] = [];
    await expect(page.getByRole('button', { name: 'Machine learning, a system', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // The whole universe with the chip on (the chip, the dim and the rings are all painted), then a star, then its planet.
    await inCommon(page).click();
    await expect(inCommon(page)).toContainText('Showing what you share');
    stops.push(await paintedColours(page));
    await page.getByRole('button', { name: 'ci SYSTEM 0, a system, you have this too', exact: true }).click();
    const planet = page.getByRole('button', { name: 'Orbit, a planet', exact: true });
    await expect(planet).toBeVisible({ timeout: 30_000 });
    stops.push(await paintedColours(page));
    await planet.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Orbit', exact: true })).toBeVisible({ timeout: 30_000 });
    stops.push(await paintedColours(page));
    seen[appearance] = stops;
    await page.close();
  }
  // Something was read at every stop, so the comparison below compares the screen and not two empty lists.
  for (const stop of seen['light'] ?? []) expect(stop.length).toBeGreaterThan(5);
  expect(seen['light']).toHaveLength(3);
  expect(seen['light']).toEqual(seen['dark']);
});
