import { expect, test, type Page } from '@playwright/test';
import { signedInAccount } from './account-fixture';
import { encounterFixture } from './encounter-fixture';

/**
 * Reflow and text size on the production export (WCAG 1.4.4, 1.4.10, V01): at the narrowest phone,
 * a landscape phone and with every text doubled, the page never scrolls sideways and no text runs
 * past the right edge. Labelled HTTP fixtures, no backend.
 */

const sizes = [
  { width: 320, height: 568, label: 'a 320 px phone' },
  { width: 844, height: 390, label: 'a landscape phone' },
] as const;

/** How far the page scrolls sideways, and the text that ends beyond the window (outside strips that scroll on purpose). */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clipped = [...document.querySelectorAll<HTMLElement>('[dir="auto"]')]
      .filter((node) => !node.closest('[data-testid="episode-navigator"]'))
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.right > width + 1;
      })
      .map((node) => (node.textContent ?? '').slice(0, 40));
    return { sideways: document.documentElement.scrollWidth - width, clipped };
  });
}

async function doubleText(page: Page) {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      const style = getComputedStyle(node);
      node.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
      node.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
    }
  });
}

const routes = ['/saved', '/conversations', '/account', '/account/privacy', '/friends'] as const;

for (const size of sizes) {
  test(`signed-in routes reflow on ${size.label}`, async ({ page }) => {
    await signedInAccount(page);
    await page.setViewportSize(size);
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await overflow(page), route).toEqual({ sideways: 0, clipped: [] });
    }
  });
}

test('signed-in routes keep their text inside the window with every text doubled', async ({ page }) => {
  await signedInAccount(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of routes) {
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await doubleText(page);
    expect(await overflow(page), `${route} at 200% text`).toEqual({ sideways: 0, clipped: [] });
  }
});

test('an encounter reflows on a landscape phone and with doubled text', async ({ page }) => {
  await encounterFixture(page, 'scroll', { viewport: { width: 844, height: 390 } });
  await page.goto('/explore');
  await expect(page.getByTestId('encounter-page')).toContainText('CI encounter fixture 1');
  expect(await overflow(page)).toEqual({ sideways: 0, clipped: [] });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('encounter-page')).toContainText('CI encounter fixture 1');
  await doubleText(page);
  expect(await overflow(page)).toEqual({ sideways: 0, clipped: [] });
});

test('motion is reduced when the person asks for it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signedInAccount(page);
  await page.goto('/saved');
  await expect(page.getByRole('main')).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  // The Skeleton, the sheets and the maps read this through the display; none of them may animate under it.
  expect(
    await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity)
          .length,
    ),
  ).toBe(0);
});
