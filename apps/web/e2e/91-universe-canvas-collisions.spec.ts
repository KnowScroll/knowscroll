import { expect, test } from './support/fixtures.ts';

/**
 * #116. The universe canvas laid its bodies out over the whole screen while the title HUD, the
 * call to action, the legend, the hint and the dock were drawn on top of it, so at 1440x900 the
 * bottom row's labels ran underneath the "Enter Scroll" block. Nothing in this repository
 * noticed: jsdom has no layout, and a screenshot asserts nothing on its own.
 *
 * This measures it. Every body's rectangle is compared with every piece of frame chrome at both
 * fidelity-tested widths (ui-system.md sec.7), in a real browser with real layout. Numbered "91-"
 * so it runs after the specs that Keep, which is what puts bodies on the canvas at all.
 */
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
] as const;

const CHROME = ['.universe-title', '.universe-cta-block', '.universe-legend', '.universe-hint', '.universe-dock', '.map-tools'];

test.describe('the universe canvas keeps clear of the frame drawn over it', () => {
  for (const viewport of viewports) {
    test(`no body overlaps the frame at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: 'Saved Traces' })).toBeVisible();

      const overlaps = await page.evaluate(selectors => {
        const intersects = (a: DOMRect, b: DOMRect) =>
          !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        const chrome = selectors
          .map(selector => [selector, document.querySelector(selector)] as const)
          .filter((pair): pair is readonly [string, Element] => pair[1] !== null)
          .map(([selector, element]) => [selector, element.getBoundingClientRect()] as const);
        const found: string[] = [];
        for (const body of Array.from(document.querySelectorAll('.body-button'))) {
          const rect = body.getBoundingClientRect();
          for (const [selector, chromeRect] of chrome) {
            if (intersects(rect, chromeRect)) found.push(`${(body.textContent ?? '').trim().slice(0, 32)} × ${selector}`);
          }
        }
        return found;
      }, CHROME);

      expect(overlaps, `bodies overlapping the frame at ${viewport.name}`).toEqual([]);
    });
  }

  test('the keyboard help line is not hidden behind the centred dock', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await page.getByRole('button', { name: /Revisit the saved Trace/ }).first().click();
    await expect(page.getByRole('article')).toBeVisible();

    const hidden = await page.evaluate(() => {
      const help = document.querySelector('.keyboard-help');
      const dock = document.querySelector('.universe-dock');
      if (!help || !dock) return 'missing';
      const a = help.getBoundingClientRect();
      const b = dock.getBoundingClientRect();
      return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    });

    expect(hidden).toBe(false);
  });
});
