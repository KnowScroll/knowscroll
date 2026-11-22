import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import broadStreet from '@knowscroll/scroll-model/fixtures/broad-street-v3-ci.json';
import { coverFrameOfV3, describePicture, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { signedInAccount } from './account-fixture';
import { id } from './encounter-fixture';

/**
 * The operator's review of held Scrolls (#780), in the production export over labelled HTTP fixtures (no backend): from the
 * Operator screen's link to the list, one held Scroll's cover and essay drawn by the real renderer, Sources, the checks in
 * words, Reject (which needs a reason) and Release (which returns to the list), in Light and Dark at a phone's and a desktop's
 * size, each with the accessibility scan the other specs use. The held document is the labelled CI fixture
 * `broad-street-v3-ci`; the answers are authored here, so this proves what the page sends and shows, not what the server
 * decides (`tests/integration/modules/operator-review.test.ts` is the server). Set `KS_REVIEW_SHOTS` to a folder to keep a
 * screenshot of each step.
 */
const document = broadStreet as unknown as ScrollDocumentV3;
const frame = coverFrameOfV3(document);
if (frame === undefined) throw new Error('the fixture shows a picture');
const coverWords = describePicture(frame.picture, frame.state);

const ASSET = id(700);
const OTHER = id(701);
const FIRST_BEAT = 'b1';
const FIRST_QUOTE = 'The first cases came on the last night of August.';
const END_QUOTE = 'The pump handle was removed.';

const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const viewports = [
  { label: '390 x 844', name: '390', viewport: phone },
  { label: '1440 x 900', name: '1440', viewport: desktop },
] as const;
const appearances = ['light', 'dark'] as const;
type Appearance = (typeof appearances)[number];

const problem = (code: string, status: number) => ({
  type: `tag:knowscroll,2026:problem:${code}`,
  title: code,
  status,
  code,
});

const unavailable = { status: 'unavailable', reason: 'no_tier0_source' };
const panels = {
  generatedAt: '2026-11-22T01:00:00.000Z',
  overview: {
    queues: { status: 'available', data: [] },
    providerOutcomes: { status: 'available', data: [] },
    recentErrors: { status: 'available', data: [] },
    serviceHealth: unavailable,
    requestLatency: unavailable,
    mediaDisk: unavailable,
  },
  production: {
    runs: { status: 'available', data: [] },
    refusedAnswers: { status: 'available', data: [] },
    reelOrders: { status: 'available', data: [] },
    usage: { status: 'unavailable', reason: 'view_missing' },
    plannedDemand: { status: 'unavailable', reason: 'view_missing' },
  },
  universeChange: { cartographer: { status: 'unavailable', reason: 'read_failed' } },
  safety: { reports: { status: 'available', data: { last24Hours: 0, recent: [] } } },
  rooms: { calls: { status: 'unavailable', reason: 'view_missing' } },
  realtime: { delivery: unavailable },
  privacy: {
    operations: { status: 'available', data: { groups: [], failed: [] } },
    retentionJobs: { status: 'available', data: [] },
    droppedDiagnostics: unavailable,
  },
};

const listItem = (assetId: string, title: string) => ({
  assetId,
  revision: 1,
  title,
  kicker: 'Fixture',
  documentVersion: 'scroll-document.v3',
  heldAt: '2026-11-21T09:30:00.000Z',
  recipe: 'broad-street',
  topic: 'earth.cholera',
  coverage: 'mapped',
  readingMinutes: 3,
  answerCheck: null,
  supportCheck: 'flagged',
});

const show = {
  assetId: ASSET,
  revision: 1,
  heldAt: '2026-11-21T09:30:00.000Z',
  recipe: 'broad-street',
  topic: 'earth.cholera',
  coverage: 'mapped',
  document,
  cover: { version: 'offer-cover.v2', kicker: 'Fixture', readingMinutes: 3, readStops: 13, figure: frame },
  parts: [
    { partId: FIRST_BEAT, passages: [{ quote: FIRST_QUOTE, source: 'A labelled fixture page' }] },
    { partId: 'a1', passages: [{ quote: 'The plan was drawn by hand.', source: 'Another fixture page' }] },
    { partId: 'takeaway', passages: [{ quote: END_QUOTE, source: 'A labelled fixture page' }] },
  ],
  answerCheck: null,
  supportCheck: {
    verdict: 'flagged',
    checker: 'library-support.v1',
    policy: 'library-support-policy.v1',
    code: null,
    counts: { sentences: 40, supported: 36, unsupported: 1, unclear: 1, noClaim: 2 },
    attention: [
      {
        partId: 'b2',
        field: 'paragraph',
        n: 7,
        outcome: 'unsupported',
        text: 'Five hundred people died in ten days.',
        problem: 'The passages give a smaller count.',
      },
    ],
  },
};

interface Served {
  /** The decisions the page sent, in order. */
  readonly decisions: { path: string; body: Record<string, unknown> | null }[];
  readonly held: () => readonly string[];
}

/** The operator routes over authored answers; a decision takes the revision out of the held list, as the gate does. */
async function serveReview(
  page: Page,
  options: { readonly operator?: boolean; readonly release?: Record<string, unknown> } = {},
): Promise<Served> {
  await signedInAccount(page);
  const held = new Set([ASSET, OTHER]);
  const decisions: Served['decisions'] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: status === 200 ? 'application/json' : 'application/problem+json',
      body: JSON.stringify(body),
    });
  // Registered after the account's routes, so it answers first.
  await page.route('**/v1/operator/**', (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (options.operator === false) return json(route, problem('NOT_FOUND', 404), 404);
    if (pathname === '/v1/operator/panels') return json(route, panels);
    if (pathname === '/v1/operator/review')
      return json(route, {
        revisions: [...held].map((assetId) =>
          listItem(assetId, assetId === ASSET ? document.title : 'A second held Scroll'),
        ),
      });
    const [, assetId, revision, action] =
      /^\/v1\/operator\/review\/([^/]+)\/(\d+)(?:\/(release|reject))?$/.exec(pathname) ?? [];
    if (assetId === undefined || revision !== '1' || !held.has(assetId))
      return json(route, problem('NOT_FOUND', 404), 404);
    if (action === undefined) return json(route, show);
    decisions.push({ path: pathname, body: request.postDataJSON() as Record<string, unknown> | null });
    if (action === 'release' && options.release !== undefined) return json(route, options.release);
    held.delete(assetId);
    return json(
      route,
      action === 'release'
        ? { outcome: 'released', reason: null, replacedRevision: null }
        : { outcome: 'rejected', reason: null },
    );
  });
  return { decisions, held: () => [...held] };
}

async function start(page: Page, viewport: { width: number; height: number }, appearance: Appearance) {
  await page.setViewportSize(viewport);
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    ['ks.device.preferences', JSON.stringify({ appearance })] as const,
  );
}

async function shot(page: Page, step: string, viewport: string, appearance: Appearance) {
  const folder = process.env['KS_REVIEW_SHOTS'];
  if (folder === undefined || folder === '') return;
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${folder}/${step}-${viewport}-${appearance}.png` });
}

async function seriousViolations(page: Page) {
  // A cover draws its picture in; it is measured once it has stopped.
  await page.waitForTimeout(700);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

const scroller = (page: Page) => page.getByTestId('folio-scroller');
const cover = (page: Page) => page.getByTestId('essay-cover');

/** Opens the held Scroll from the list and waits for its cover. */
async function openHeld(page: Page) {
  await page.getByTestId(`review-row-${ASSET}`).click();
  await expect(cover(page)).toBeVisible();
}

/** Reads on from the cover, and brings the decision panel into view at the end of the essay. */
async function readToTheEnd(page: Page) {
  await page.getByTestId('essay-cover-read').click();
  await expect(scroller(page)).toBeVisible();
  await page.getByTestId('review-release').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('review-release')).toBeVisible();
}

for (const appearance of appearances) {
  for (const { label, name, viewport } of viewports) {
    test.describe(`in ${appearance} at ${label}`, () => {
      test('goes from the Operator screen to the list, a cover and the essay, and Sources shows what a part cites', async ({
        page,
      }) => {
        await serveReview(page);
        await start(page, viewport, appearance);
        await page.goto('/operator');
        await page.getByRole('link', { name: 'Review held Scrolls' }).click();
        await expect(page).toHaveURL(/\/operator\/review$/u);
        await expect(page.getByRole('heading', { level: 1, name: 'Held Scrolls' })).toBeVisible();
        await expect(page.getByTestId(`review-row-${ASSET}`)).toBeVisible();
        await expect(page.getByText('Support: flagged').first()).toBeVisible();
        expect(await seriousViolations(page)).toEqual([]);
        await shot(page, 'list', name, appearance);

        await openHeld(page);
        await expect(page).toHaveURL(new RegExp(`/operator/review/${ASSET}/1$`, 'u'));
        // The cover as Explore draws it: its words, its picture by the general renderer, its place in the hand.
        await expect(cover(page).getByRole('heading', { level: 1, name: document.title })).toBeVisible();
        await expect(
          page.getByTestId('essay-cover-figure').getByRole('img', { name: coverWords, exact: true }),
        ).toBeVisible();
        await expect(cover(page).getByText('1 OF 2')).toBeVisible();
        // The checks are at the top in plain words: open where there is room, as chips on a phone until they are unfolded.
        await expect(page.getByTestId('review-findings')).toContainText('Support');
        expect(await seriousViolations(page)).toEqual([]);
        await shot(page, 'cover', name, appearance);
        const unfold = page.getByRole('button', { name: 'Unfold the checks' });
        if ((await unfold.count()) > 0) await unfold.click();
        await expect(page.getByTestId('review-finding-support')).toContainText('Support check: flagged');
        await expect(page.getByTestId('review-sentences')).toContainText('Five hundred people died in ten days.');
        expect(await seriousViolations(page)).toEqual([]);
        await shot(page, 'cover-checks', name, appearance);

        await page.getByTestId('essay-cover-read').click();
        await expect(scroller(page)).toBeVisible();
        await expect(cover(page)).toHaveCount(0);
        await expect(scroller(page).getByRole('heading', { level: 1, name: document.title })).toBeVisible();
        await expect(scroller(page).getByRole('img', { name: coverWords, exact: true }).first()).toBeAttached();
        // No sources until they are asked for.
        await expect(page.getByTestId(`review-sources-${FIRST_BEAT}`)).toHaveCount(0);
        await page.getByTestId('review-sources-toggle').click();
        const sources = page.getByTestId(`review-sources-${FIRST_BEAT}`);
        await expect(sources).toBeVisible();
        await expect(sources).toContainText(FIRST_QUOTE);
        await expect(sources).toContainText('A labelled fixture page');
        // A source is a quotation and the title of its page, never an address.
        await expect(sources).not.toContainText('http');
        expect(await seriousViolations(page)).toEqual([]);
        await sources.scrollIntoViewIfNeeded();
        await shot(page, 'essay-sources', name, appearance);

        await page.getByTestId('review-release').scrollIntoViewIfNeeded();
        await expect(page.getByTestId('review-sources-rest')).toContainText(END_QUOTE);
        expect(await seriousViolations(page)).toEqual([]);
        await shot(page, 'decision', name, appearance);
      });

      test('needs a reason to reject, asks in the page before releasing, and returns to the list after a release', async ({
        page,
      }) => {
        const served = await serveReview(page);
        await start(page, viewport, appearance);
        let dialogs = 0;
        page.on('dialog', (dialog) => {
          dialogs += 1;
          void dialog.dismiss();
        });
        await page.goto('/operator/review');
        await openHeld(page);
        await readToTheEnd(page);

        // Reject asks for a reason first, and the button stays off while there is none.
        await page.getByTestId('review-reject').click();
        const confirmReject = page.getByTestId('review-reject-confirm');
        await expect(confirmReject).toBeVisible();
        await expect(confirmReject).toBeDisabled();
        await page.getByTestId('review-reject-reason').fill('   ');
        await expect(confirmReject).toBeDisabled();
        await page.getByTestId('review-reject-reason').fill('The second picture says the opposite.');
        await expect(confirmReject).toBeEnabled();
        expect(await seriousViolations(page)).toEqual([]);
        await shot(page, 'reject', name, appearance);
        await page.getByRole('button', { name: 'Not yet' }).click();
        await expect(confirmReject).toHaveCount(0);
        expect(served.decisions).toEqual([]);

        // Release asks once, in the page, and sends nothing until it is confirmed.
        await page.getByTestId('review-release').click();
        await expect(page.getByTestId('review-confirm-release')).toBeVisible();
        expect(served.decisions).toEqual([]);
        await shot(page, 'release-confirm', name, appearance);
        await page.getByTestId('review-release-confirm').click();
        await expect(page).toHaveURL(/\/operator\/review$/u);
        await expect(page.getByRole('heading', { level: 1, name: 'Held Scrolls' })).toBeVisible();
        expect(served.decisions).toEqual([{ path: `/v1/operator/review/${ASSET}/1/release`, body: null }]);
        // The released revision is gone from the list; the other is still held.
        await expect(page.getByTestId(`review-row-${ASSET}`)).toHaveCount(0);
        await expect(page.getByTestId(`review-row-${OTHER}`)).toBeVisible();
        expect(served.held()).toEqual([OTHER]);
        expect(dialogs).toBe(0);
      });
    });
  }
}

test.describe('the decisions and the pages around them', () => {
  test('rejects with the reason the operator gave and returns to the list', async ({ page }) => {
    const served = await serveReview(page);
    await start(page, phone, 'light');
    await page.goto(`/operator/review/${ASSET}/1`);
    await expect(cover(page)).toBeVisible();
    await readToTheEnd(page);
    await page.getByTestId('review-reject').click();
    await page.getByTestId('review-reject-reason').fill('The second picture says the opposite.');
    await page.getByTestId('review-reject-confirm').click();
    await expect(page).toHaveURL(/\/operator\/review$/u);
    expect(served.decisions).toEqual([
      { path: `/v1/operator/review/${ASSET}/1/reject`, body: { reason: 'The second picture says the opposite.' } },
    ]);
    expect(served.held()).toEqual([OTHER]);
  });

  test('says why the gate refused a release and stays on the Scroll', async ({ page }) => {
    await serveReview(page, { release: { outcome: 'refused', reason: 'coverage_missing', replacedRevision: null } });
    await start(page, phone, 'light');
    await page.goto(`/operator/review/${ASSET}/1`);
    await readToTheEnd(page);
    await page.getByTestId('review-release').click();
    await page.getByTestId('review-release-confirm').click();
    await expect(page.getByTestId('review-refused')).toContainText('its coverage is not mapped');
    await expect(page).toHaveURL(new RegExp(`/operator/review/${ASSET}/1$`, 'u'));
    await expect(page.getByTestId('review-release')).toBeVisible();
  });

  test('shows an account that is not an operator the unknown-page screen on every review address', async ({ page }) => {
    await serveReview(page, { operator: false });
    await start(page, phone, 'light');
    for (const path of ['/operator/review', `/operator/review/${ASSET}/1`]) {
      await page.goto(path);
      await expect(page.getByText("This page isn't here")).toBeVisible();
      await expect(page.getByText('Held Scrolls')).toHaveCount(0);
      await expect(page.getByTestId('review-page')).toHaveCount(0);
    }
  });

  test('shows a revision that is not held the same unknown-page screen', async ({ page }) => {
    await serveReview(page);
    await start(page, phone, 'light');
    await page.goto(`/operator/review/${id(799)}/1`);
    await expect(page.getByText("This page isn't here")).toBeVisible();
    await page.goto(`/operator/review/${ASSET}/not-a-number`);
    await expect(page.getByText("This page isn't here")).toBeVisible();
  });
});
