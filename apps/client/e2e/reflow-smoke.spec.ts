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

/**
 * How far the page scrolls sideways, the text that ends beyond the window (outside strips that
 * scroll on purpose), and the pairs of texts drawn over each other.
 */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const texts = [...document.querySelectorAll<HTMLElement>('[dir="auto"]')].filter((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        node.textContent?.trim() !== '' &&
        node.querySelector('[dir="auto"]') === null &&
        // The floating tab bar and rail are drawn over the page on purpose; the page keeps clear of them at its end.
        node.closest('[role="navigation"], nav') === null
      );
    });
    const clipped = texts
      .filter((node) => !node.closest('[data-testid="episode-navigator"]'))
      .filter((node) => node.getBoundingClientRect().right > width + 1)
      .map((node) => (node.textContent ?? '').slice(0, 40));
    const overlapping: string[] = [];
    for (const [index, first] of texts.entries()) {
      for (const second of texts.slice(index + 1)) {
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 2 && down > 2)
          overlapping.push(`${(first.textContent ?? '').slice(0, 24)} | ${(second.textContent ?? '').slice(0, 24)}`);
      }
    }
    return { sideways: document.documentElement.scrollWidth - width, clipped, overlapping };
  });
}

/**
 * The browser's text size at 200 %: the root font size doubles, and the app (which reads it as its
 * system text size, `useDisplay().textScale`) resizes its own text by the 200 % rules of the type scale.
 */
async function doubleText(page: Page) {
  const sizes = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main [dir="auto"]')].reduce(
        (sum, node) => sum + Number.parseFloat(getComputedStyle(node).fontSize),
        0,
      ),
    );
  const before = await sizes();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
    window.dispatchEvent(new Event('resize'));
  });
  // The app took the browser's size as its own text size: its text really is larger now.
  await expect.poll(sizes).toBeGreaterThan(before * 1.2);
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
      expect(await overflow(page), route).toEqual({ sideways: 0, clipped: [], overlapping: [] });
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
    expect(await overflow(page), `${route} at 200% text`).toEqual({ sideways: 0, clipped: [], overlapping: [] });
  }
});

test('an encounter reflows on a landscape phone and with doubled text', async ({ page }) => {
  await encounterFixture(page, 'scroll', { viewport: { width: 844, height: 390 } });
  await page.goto('/explore');
  await expect(page.getByTestId('encounter-page')).toContainText('CI encounter fixture 1');
  // The first-arrival hint floats over the article by design: put it away first.
  await page.getByRole('button', { name: 'Got it' }).click();
  expect(await overflow(page)).toEqual({ sideways: 0, clipped: [], overlapping: [] });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('encounter-page')).toContainText('CI encounter fixture 1');
  await doubleText(page);
  expect(await overflow(page)).toEqual({ sideways: 0, clipped: [], overlapping: [] });
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
