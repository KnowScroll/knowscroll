import { expect, test } from './support/fixtures.ts';

/**
 * #119. The dock floats over the stage, so a level whose content reaches the bottom of the
 * window has it drawn *on top of* that content. On the privacy level the section it covered was
 * Reset -- the most destructive control the product has, sitting under a panel. This is the same
 * failure the #107 evidence recorded three times (rails and sheets hiding reachable controls),
 * and the same reason `91-universe-canvas-collisions.spec.ts` exists: jsdom has no layout and a
 * screenshot asserts nothing, so only a real browser can see it.
 *
 * The head band's provenance line is checked here too. It says where the data on the screen came
 * from, and it was being clipped mid-word with no ellipsis ("...read from the database it"),
 * because `text-overflow` does not apply to a flex container's anonymous text item -- so the one
 * sentence explaining the screen's own honesty was the thing that went unread.
 */
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
] as const;

test.describe('the privacy level is not covered or clipped by its own frame', () => {
  for (const viewport of viewports) {
    test(`the dock covers no privacy section at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.getByRole('button', { name: /Privacy/i }).first().click();
      await expect(page.getByRole('heading', { name: 'Reset your universe' })).toBeVisible();

      const covered = await page.evaluate(() => {
        const intersects = (a: DOMRect, b: DOMRect) =>
          !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        const dock = document.querySelector('.universe-dock');
        const stage = document.querySelector('.privacy-stage');
        if (!dock || !stage) return ['the privacy level is missing its dock or its stage'];
        const dockRect = dock.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        // `getBoundingClientRect()` reports a section's full geometry even where an
        // ancestor's `overflow` visually clips it, so comparing raw rects reports a
        // collision for content that is scrolled out of sight. What matters is the
        // part actually painted: the section's rect intersected with its scroll
        // container's.
        const visiblePart = (rect: DOMRect): DOMRect | null => {
          const top = Math.max(rect.top, stageRect.top);
          const bottom = Math.min(rect.bottom, stageRect.bottom);
          const left = Math.max(rect.left, stageRect.left);
          const right = Math.min(rect.right, stageRect.right);
          if (bottom <= top || right <= left) return null;
          return new DOMRect(left, top, right - left, bottom - top);
        };
        return Array.from(document.querySelectorAll('.privacy-section'))
          .flatMap(section => {
            const visible = visiblePart(section.getBoundingClientRect());
            return visible && intersects(visible, dockRect)
              ? [(section.textContent ?? '').trim().slice(0, 40)]
              : [];
          });
      });

      expect(covered, `privacy sections under the dock at ${viewport.name}`).toEqual([]);
    });

    test(`the head band's provenance line is fully readable at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.getByRole('button', { name: /Privacy/i }).first().click();
      await expect(page.getByRole('heading', { name: 'Reset your universe' })).toBeVisible();

      const clipped = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.head-band-origin'))
          .filter(element => element.scrollWidth > element.clientWidth + 1)
          .map(element => ({
            text: (element.textContent ?? '').trim(),
            needs: element.scrollWidth,
            has: element.clientWidth,
          })),
      );

      expect(clipped, `clipped head-band text at ${viewport.name}`).toEqual([]);
    });
  }
});
