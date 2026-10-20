import { expect, test, type Page } from '@playwright/test';

/**
 * The Scroll renderer in a real browser (the gallery export, `/gallery-scroll`, fixture documents):
 * real headings for the rotor, the disclosure and the code block by keyboard, Copy through the
 * real clipboard, the readable fallback, the anchor restore, and the reading events the article
 * reports (`window.__ksScrollGallery`). Phone and desktop widths.
 */

interface GalleryEvents {
  visibility: { blockId: string; visibleFraction: number }[];
  interactions: { blockId: string; kind: string }[];
  activity: { active: boolean }[];
  diagnostics: { blockId: string; blockType: string; reason: string }[];
}

async function events(page: Page): Promise<GalleryEvents> {
  return page.evaluate(() => (window as unknown as { __ksScrollGallery: GalleryEvents }).__ksScrollGallery);
}

async function open(page: Page, query = '') {
  await page.goto(`/gallery-scroll${query}`);
  await expect(page.getByTestId('ks-scroll-gallery')).toBeVisible();
}

test.describe('phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('is in the gallery build only, titled, and opens as a poster', async ({ page }) => {
    await open(page);

    await expect(page).toHaveTitle('Scroll gallery · KnowScroll');
    await expect(page.getByRole('heading', { level: 1, name: 'Why bridges stay up' })).toBeVisible();
    await expect(page.getByText('A Scroll · 2 min', { exact: false })).toBeVisible();
  });

  test('has real h1, h2 and h3 headings for rotor and landmark navigation', async ({ page }) => {
    await open(page);

    await expect(page.getByRole('heading', { level: 2, name: 'Pushing and pulling' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 3, name: 'Where the force goes' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 2, name: 'Reading a load check' })).toHaveCount(1);
  });

  test('a disclosure opens and closes from the keyboard, and remembers its state across documents', async ({
    page,
  }) => {
    await open(page);
    const summary = page.getByRole('button', { name: 'Why a safety factor?' });
    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');

    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('safety factor', { exact: true })).toBeVisible();
    await page.keyboard.press(' ');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');

    // Another document and back: the state is kept by (revision, block id).
    await page.getByRole('button', { name: 'Editorial' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'How lighthouse keepers kept the night' })).toBeVisible();
    await page.getByRole('button', { name: 'Poster' }).click();
    const again = page.getByRole('button', { name: 'Why a safety factor?' });
    await again.scrollIntoViewIfNeeded();
    await expect(again).toHaveAttribute('aria-expanded', 'true');
    expect(
      (await events(page)).interactions.filter((entry) => entry.kind === 'disclosure').length,
    ).toBeGreaterThanOrEqual(3);
  });

  test('the code scrolls sideways inside its frame, by keyboard, and never widens the article', async ({ page }) => {
    await open(page);
    const code = page.getByLabel('Code example, scrolls horizontally');
    await code.scrollIntoViewIfNeeded();
    await expect(code).toHaveAttribute('tabindex', '0');
    const sizes = await code.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    const page_ = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(page_.scroll).toBeLessThanOrEqual(page_.client);

    await code.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });

  test('Copy puts the code on the real clipboard and says "Copied"', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    const copy = page.getByRole('button', { name: 'Copy', exact: true });
    await copy.scrollIntoViewIfNeeded();

    await copy.click();

    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('def deck_load(span_m, traffic_kn):');
    expect((await events(page)).interactions).toContainEqual({ blockId: 'code-load', kind: 'copy' });
  });

  test('Tab order is reading order: Copy, then the code, then the disclosure', async ({ page }) => {
    await open(page);
    const names: string[] = [];
    for (let step = 0; step < 14 && !names.includes('Why a safety factor?'); step += 1) {
      await page.keyboard.press('Tab');
      names.push(
        await page.evaluate(() => {
          const element = document.activeElement;
          return element?.getAttribute('aria-label') ?? element?.textContent ?? '';
        }),
      );
    }

    const order = ['Copy', 'Code example, scrolls horizontally', 'Why a safety factor?'].map((name) =>
      names.indexOf(name),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('a block this build cannot draw shows its own words, with no Retry and a diagnostic', async ({ page }) => {
    await open(page);

    await expect(page.getByText('This part needs an app update · text version')).toBeVisible();
    await expect(page.getByText('The deck passes its load to the cables')).toBeVisible();
    await expect(page.getByRole('button', { name: /retry|try again/i })).toHaveCount(0);
    expect((await events(page)).diagnostics).toContainEqual({
      blockId: 'diagram-load',
      blockType: 'diagram',
      reason: 'unsupported-by-client',
    });
  });

  test('restores to a block by its id and flashes it on the highlight ground', async ({ page }) => {
    await open(page, '?block=code-load');

    const block = page.locator('#block-code-load');
    await expect.poll(async () => (await block.boundingBox())?.y ?? 9999).toBeLessThan(200);
    await expect(block).toHaveCSS('background-color', 'rgb(255, 244, 194)');
    // The flash is brief: it is gone a moment later.
    await expect(block).not.toHaveCSS('background-color', 'rgb(255, 244, 194)', { timeout: 5000 });
  });

  test('opens the disclosure that holds a block restored by its id', async ({ page }) => {
    await open(page, '?block=safety-why');

    await expect(page.getByRole('button', { name: 'Why a safety factor?' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('safety factor', { exact: true })).toBeVisible();
  });

  test('reports what is visible, by the observer rule, and that the article is active', async ({ page }) => {
    await open(page);

    await expect
      .poll(async () =>
        (await events(page)).visibility.some((entry) => entry.blockId === 'p-open-1' && entry.visibleFraction > 0),
      )
      .toBe(true);
    const first = await events(page);
    expect(first.activity).toContainEqual({ active: true });
    // Scrolled out of view: the same block reports 0 again.
    await page.locator('#block-code-load').scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const reported = (await events(page)).visibility.filter((entry) => entry.blockId === 'p-open-1');
        return reported[reported.length - 1]?.visibleFraction;
      })
      .toBe(0);
  });

  test('the server fallback document reads the same as the unrendered block', async ({ page }) => {
    await open(page, '?doc=fallback');

    await expect(page.getByText('This part needs an app update · text version')).toBeVisible();
    await expect(page.getByText('the towers pass it down to the ground', { exact: false })).toBeVisible();
  });

  test('the editorial opens with a drop cap that leaves the paragraph text whole, a correction and its framing', async ({
    page,
  }) => {
    await open(page, '?doc=lighthouse');

    await expect(page.getByText('Corrected 14 Oct.')).toBeVisible();
    await expect(page.getByText('Hypothetical', { exact: true })).toBeVisible();
    const paragraph = page.locator('[data-ks-drop-cap]').first();
    await expect(paragraph).toHaveText(/^For a century the safest thing on a dangerous coast/);
    await expect(paragraph).toHaveCSS('font-size', '18px');
    const floated = await paragraph.evaluate((element) => getComputedStyle(element, '::first-letter').float);
    expect(floated).toBe('left');
  });
});

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('sets the reading column at 680 px (880 for code) and centres it', async ({ page }) => {
    await open(page);

    const paragraph = await page.locator('#block-p-open-1').boundingBox();
    const code = await page.locator('#block-code-load').boundingBox();
    expect(Math.round(paragraph?.width ?? 0)).toBe(680);
    expect(Math.round(code?.width ?? 0)).toBe(880);
    expect(Math.round((paragraph?.x ?? 0) + (paragraph?.width ?? 0) / 2)).toBe(640);
  });
});
