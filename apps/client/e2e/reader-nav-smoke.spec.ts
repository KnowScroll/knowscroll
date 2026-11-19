import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, id, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * How a v2 Scroll moves between Parts, and how its top bar and end card read, wherever it is opened
 * (D-134, D-184, D-185). The document is the labelled CI fixture `seasons-stage-ci` (not product content)
 * served by authored HTTP fixtures, so this proves the app's wiring, not the backend.
 */

const phone = { width: 390, height: 844 };

/** The Scroll with its stage taken away: a plain v2 Scroll, with no picture for the end plate to draw. */
const plain = (() => {
  const { stage: _stage, ...rest } = seasons as unknown as Record<string, unknown>;
  // With no picture there is nothing for the Final call to turn, so it is no longer bound to one (D-187).
  const stops = (rest['stops'] as Record<string, unknown>[]).map(({ binding: _binding, ...stop }) => stop);
  return { ...rest, stops };
})();

/** Opens the first Part of a series on its own address, as a person who followed a link does. */
async function openByAddress(
  page: Page,
  direct: NonNullable<EncounterFixtureOptions['direct']>,
  options: { viewport?: { width: number; height: number }; document?: Record<string, unknown>; part?: number } = {},
) {
  const served = await encounterFixture(page, 'scroll', {
    viewport: options.viewport ?? phone,
    direct,
    scrollDocument: options.document ?? seasons,
  });
  await page.goto(`/scroll/${id(300 + (options.part ?? 0))}`);
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  return served;
}

/** Opens the same Scroll from Explore, as a person who was offered it does. */
async function openFromExplore(page: Page, viewport = phone) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await expect(title(page, 1)).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

/** The Scroll's title in the top bar (the essay repeats it in its opening). */
const title = (page: Page, part: number) =>
  page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: `CI encounter fixture ${String(part)}` });
const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
/** The dock's way on, named for where it goes ("Part 2: <title>"). The link to the Part before is named alike, so it is looked for in the dock. */
const dock = (page: Page) => page.getByTestId('reader-dock').getByRole('button', { name: /^Part \d: / });
const plate = (page: Page) => page.getByTestId('end-plate');
/** Goes to the end, as a person who pressed End. */
async function toTheEnd(page: Page) {
  await reader(page).focus();
  await page.keyboard.press('End');
  await expect(plate(page)).toBeInViewport();
}
const opened = (served: { commands: { path: string; body: Record<string, unknown> }[] }) =>
  served.commands
    .filter((call) => call.path === '/v1/experience/open')
    .map((call) => (call.body.target as { assetId: string }).assetId);

test.describe('a Scroll opened by its address (/scroll/<id>)', () => {
  test('Part 2 is in the dock, and the button, the key and the left arrow move between Parts', async ({ page }) => {
    const served = await openByAddress(page, { parts: 3 });
    await expect(title(page, 1)).toBeVisible();
    await expect(page.getByText('Part 1 of 3').first()).toBeVisible();
    await expect(dock(page)).toHaveText('Part 2');
    // The first Part has no Part before it.
    await expect(page.getByTestId('folio-previous-part')).toHaveCount(0);
    await reader(page).focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    await expect(title(page, 1)).toBeVisible();
    expect(opened(served)).toEqual([id(300)]);

    await dock(page).click();
    await expect(title(page, 2)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/scroll/${id(301)}$`));
    await expect(dock(page)).toHaveText('Part 3');

    await reader(page).focus();
    await page.keyboard.press('ArrowRight');
    await expect(title(page, 3)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/scroll/${id(302)}$`));
    // The last Part has no next Part: the button is gone and the key moves nothing.
    await expect(dock(page)).toHaveCount(0);
    await reader(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await expect(title(page, 3)).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(title(page, 2)).toBeVisible();
    expect(opened(served)).toEqual([id(300), id(301), id(302), id(301)]);
  });

  test('the end of a Part names the next Part, and continuing opens it', async ({ page }) => {
    await openByAddress(page, { parts: 2 });
    await toTheEnd(page);
    await plate(page)
      .getByRole('button', { name: /^Part 2 · / })
      .click();
    await expect(title(page, 2)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/scroll/${id(301)}$`));
  });

  test('the Part before is a link in the opening, and the left arrow goes there too', async ({ page }) => {
    const served = await openByAddress(page, { parts: 3 }, { part: 1 });
    await expect(title(page, 2)).toBeVisible();
    const back = page.getByTestId('folio-previous-part');
    await expect(back).toHaveAccessibleName(/^Part 1: /);
    await back.click();
    await expect(title(page, 1)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/scroll/${id(300)}$`));
    await dock(page).click();
    await expect(title(page, 2)).toBeVisible();
    await reader(page).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(title(page, 1)).toBeVisible();
    expect(opened(served)).toEqual([id(301), id(300), id(301), id(300)]);
  });

  test('a Scroll that is not in a series has no Part to move to', async ({ page }) => {
    const served = await openByAddress(page, { parts: 1 });
    await expect(title(page, 1)).toBeVisible();
    await expect(dock(page)).toHaveCount(0);
    await expect(page.getByText(/^Part \d/)).toHaveCount(0);
    await reader(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    expect(opened(served)).toEqual([id(300)]);
    await expect(page.getByTestId('folio-previous-part')).toHaveCount(0);
    await toTheEnd(page);
    await expect(plate(page).getByRole('button', { name: /^Part \d · / })).toHaveCount(0);
  });
});

test.describe('a Scroll opened from Explore', () => {
  test('the dock has Like, Share, Save, ••• and Part 2, and Ask is in •••', async ({ page }) => {
    await openFromExplore(page);
    for (const name of ['Like', 'Share a moment', 'Save', 'More'])
      await expect(page.getByTestId('reader-dock').getByRole('button', { name, exact: true })).toBeVisible();
    await expect(page.getByTestId('reader-dock').getByRole('button', { name: 'Ask about this' })).toHaveCount(0);
    await expect(dock(page)).toHaveText('Part 2');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByTestId('more-list').getByRole('button').first()).toHaveAccessibleName('Ask about this');
  });
});

const desktop = { width: 1440, height: 900 };

/** ••• then Share: one sheet, and the way to a conversation is reachable (#548). */
async function shareFromMore(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Share this Scroll', exact: true }).click();
  // The More sheet has stepped aside: only the Share sheet is open, so a tap lands on it.
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send to a conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Send to a conversation' })).toBeVisible();
}

test('closing ••• on a Part you moved on to stays on that Part', async ({ page }) => {
  await openFromExplore(page);
  await dock(page).click();
  const heading = page.getByTestId('reader-top-title').getByRole('heading', { level: 1 });
  await expect(heading).not.toHaveText('CI encounter fixture 1');
  const part2 = await heading.innerText();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
  // Closing the sheet takes its history entry off; that must not read as the person's Back.
  await page.waitForTimeout(500);
  await expect(heading).toHaveText(part2);
});

test('browser Back after ••• then Share closes the Share sheet with one pop and stays on the Scroll', async ({
  page,
}) => {
  await openFromExplore(page);
  const heading = page.getByTestId('reader-top-title').getByRole('heading', { level: 1 });
  const title = await heading.innerText();
  await page.evaluate(() => {
    const seen = { pops: 0 };
    (window as unknown as { __pops: typeof seen }).__pops = seen;
    window.addEventListener('popstate', () => {
      seen.pops += 1;
    });
  });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Share this Scroll', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send to a conversation' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Send to a conversation' })).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(heading).toHaveText(title);
  await expect(page).toHaveURL(new RegExp('/explore'));
  expect(await page.evaluate(() => (window as unknown as { __pops: { pops: number } }).__pops.pops)).toBe(1);
});

for (const [name, viewport] of [
  ['phone', phone],
  ['desktop', desktop],
] as const) {
  test.describe(`Share from the reader's ••• (${name})`, () => {
    test('a Scroll opened from Explore reaches the conversation picker', async ({ page }) => {
      await openFromExplore(page, viewport);
      await shareFromMore(page);
    });

    test('a Scroll opened by its address reaches the conversation picker', async ({ page }) => {
      await openByAddress(page, { parts: 2 }, { viewport });
      await shareFromMore(page);
    });
  });
}

test.describe('the end card', () => {
  test('a Scroll with a picture of the journey draws it on the end plate; a plain Scroll has none, and both sum up', async ({
    page,
  }) => {
    await openByAddress(page, { parts: 1 });
    await toTheEnd(page);
    await expect(plate(page).getByRole('heading', { name: 'To sum up' })).toBeVisible();
    await expect(plate(page).getByTestId('end-figure').getByRole('img')).toHaveAccessibleName(/^The picture you built/);

    await openByAddress(page, { parts: 1 }, { document: plain });
    await toTheEnd(page);
    await expect(plate(page).getByRole('heading', { name: 'To sum up' })).toBeVisible();
    await expect(page.getByTestId('end-figure')).toHaveCount(0);
    await expect(page.getByText('The picture you built')).toHaveCount(0);
  });
});

test.describe('the top bar', () => {
  for (const width of [320, 360, 390]) {
    test(`at ${String(width)} px the title, the Part and both controls are whole, and axe is clean`, async ({
      page,
    }) => {
      await openByAddress(page, { parts: 3 }, { viewport: { width, height: 844 } });
      const heading = title(page, 1);
      await expect(heading).toBeVisible();
      const where = await heading.boundingBox();
      expect(where?.height ?? 0).toBeGreaterThan(8);
      await expect(page.getByText('Part 1 of 3').first()).toBeVisible();

      if (width === 390) {
        // One line: a taller bar takes the text's room (a call's answer would not fit on screen).
        const bar = await page.getByTestId('reader-top-bar').boundingBox();
        expect(bar?.height ?? 0).toBeLessThan(70);
      }

      const clipped = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="reader-top-bar"]');
        if (bar === null) return ['no top bar'];
        const problems: string[] = [];
        for (const node of bar.querySelectorAll<HTMLElement>('*')) {
          const box = node.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          const name = node.getAttribute('aria-label') ?? node.textContent?.slice(0, 20) ?? node.tagName;
          if (box.right > window.innerWidth + 0.5 || box.left < -0.5) problems.push(`${name} leaves the screen`);
          const style = getComputedStyle(node);
          const clips = style.overflow !== 'visible' && style.webkitLineClamp === 'none';
          if (clips && node.scrollWidth > node.clientWidth + 1) problems.push(`${name} is cut off`);
        }
        return problems;
      });
      expect(clipped).toEqual([]);

      for (const name of [/^Reel/, /^Scroll/]) {
        const option = page.getByRole('radio', { name });
        const box = await option.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(40);
        expect(await option.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      }
      // The state stays in the name; the bar draws only the two formats.
      // Its name keeps the state; the bar draws only "Reel".
      await expect(page.getByRole('radio', { name: 'Reel · unavailable' })).toHaveText('Reel');
      const next = await page.getByRole('button', { name: 'Next topic' }).boundingBox();
      expect((next?.x ?? 0) + (next?.width ?? 0)).toBeLessThanOrEqual(width);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(
        results.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });
  }
});

test.describe('reading time on a Part that another screen covers', () => {
  /** The latest moment (ms into the exposure) any reported active reading of this exposure reaches. */
  const dwellEnd = (
    observed: { kind: string; exposureId: string; payload: Record<string, unknown> }[],
    exposureId: string,
  ): number =>
    Math.max(
      0,
      ...observed
        .filter((event) => event.kind === 'scroll.active_dwell' && event.exposureId === exposureId)
        .flatMap((event) => (event.payload.activeIntervalsMs as [number, number][]).map(([, to]) => to)),
    );

  test('stops when the next Part is opened over it, and picks up again on Back', async ({ page }) => {
    test.setTimeout(60_000);
    await page.clock.install();
    const { observed } = await openByAddress(page, { parts: 2 });
    await expect(title(page, 1)).toBeVisible();
    await page.clock.fastForward(6_000);
    await dock(page).click();
    await expect(title(page, 2)).toBeVisible();
    // Part 2 is read for 20 s; the recorder reports every 15 s.
    for (let step = 0; step < 4; step += 1) {
      await page.clock.fastForward(5_000);
      await page.waitForTimeout(100);
    }
    await page.clock.fastForward(1_000);
    await page.waitForTimeout(300);
    const firstPartEnd = dwellEnd(observed, id(400));
    expect(dwellEnd(observed, id(401)), 'Part 2 is being read').toBeGreaterThan(15_000);
    // Part 1 was left at about 6 s: nothing it reports reaches past that moment.
    expect(firstPartEnd, 'Part 1 was reported as read after it was left').toBeLessThan(8_000);

    // Back: Part 1 is read again, and Part 2, now covered, stops.
    await page.goBack();
    await expect(title(page, 1)).toBeVisible();
    await page.clock.fastForward(16_000);
    await page.waitForTimeout(300);
    const secondPartEnd = dwellEnd(observed, id(401));
    await page.clock.fastForward(16_000);
    await page.waitForTimeout(300);
    expect(dwellEnd(observed, id(400)), 'Part 1 is read again after Back').toBeGreaterThan(firstPartEnd + 10_000);
    expect(dwellEnd(observed, id(401)), 'Part 2 went on counting under Part 1').toBe(secondPartEnd);
  });
});
