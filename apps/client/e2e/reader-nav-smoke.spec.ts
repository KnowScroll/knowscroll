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

/** The Scroll with its stage taken away: a plain v2 Scroll. */
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
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

const title = (page: Page, part: number) =>
  page.getByRole('heading', { level: 1, name: `CI encounter fixture ${String(part)}` });
const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
/** The dock's way on, named for where it goes ("Part 2: <title>", "Related: <title>"). */
const dock = (page: Page) => page.getByRole('button', { name: /^(Part \d|Related): / });
const opened = (served: { commands: { path: string; body: Record<string, unknown> }[] }) =>
  served.commands
    .filter((call) => call.path === '/v1/experience/open')
    .map((call) => (call.body.target as { assetId: string }).assetId);

type Box = { x: number; y: number; width: number; height: number };

/** A finger drag across the page, as the browser's own touch events (the path a phone takes). */
async function fingerDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const at = (point: { x: number; y: number }) => [{ x: point.x, y: point.y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
  for (let step = 1; step <= 8; step += 1) {
    const along = step / 8;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: at({ x: from.x + (to.x - from.x) * along, y: from.y + (to.y - from.y) * along }),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const swipe = (page: Page, box: Box, from: number, to: number) => {
  const y = box.y + box.height / 2;
  return fingerDrag(page, { x: box.x + box.width * from, y }, { x: box.x + box.width * to, y: y + 8 });
};

test.describe('a Scroll opened by its address (/scroll/<id>)', () => {
  test('Part 2 is in the dock, and the button, the key and the left arrow move between Parts', async ({ page }) => {
    const served = await openByAddress(page, { parts: 3 });
    await expect(title(page, 1)).toBeVisible();
    await expect(page.getByText('Part 1 of 3').first()).toBeVisible();
    await expect(dock(page)).toHaveText('Part 2');
    // The first Part has no Part before it.
    await reader(page).focus();
    await page.keyboard.press('ArrowLeft');
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
    await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
    await page.getByRole('button', { name: 'Continue Part 2' }).click();
    await expect(title(page, 2)).toBeVisible();
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
  });

  test('a related move is offered where the context has one: in the dock when there is no next Part, and at the end', async ({
    page,
  }) => {
    const served = await openByAddress(page, { parts: 1, related: true });
    await expect(dock(page)).toHaveText('Related');
    await expect(dock(page)).toHaveAccessibleName('Related: CI encounter fixture 6');
    await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^Another related explanation: CI encounter fixture 6/ }),
    ).toBeVisible();
    await dock(page).click();
    await expect(title(page, 6)).toBeVisible();
    expect(opened(served)).toEqual([id(300), id(305)]);
  });

  test('a related move alone is also the right arrow key', async ({ page }) => {
    const served = await openByAddress(page, { parts: 1, related: true });
    await reader(page).focus();
    await page.keyboard.press('ArrowRight');
    await expect(title(page, 6)).toBeVisible();
    expect(opened(served)).toEqual([id(300), id(305)]);
  });

  test('a next Part wins the dock over a related move; both are at the end', async ({ page }) => {
    await openByAddress(page, { parts: 2, related: true });
    await expect(dock(page)).toHaveText('Part 2');
    await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue Part 2' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Another related explanation/ })).toBeVisible();
  });

  test.describe('by finger', () => {
    test.use({ hasTouch: true });

    test('a swipe left on the text takes a related move when there is no next Part', async ({ page }) => {
      const served = await openByAddress(page, { parts: 1, related: true });
      const text = await page.getByTestId('stop-scroller').boundingBox();
      if (text === null) throw new Error('the text is on the page');
      await swipe(page, text, 0.85, 0.15);
      await expect(title(page, 6)).toBeVisible();
      expect(opened(served)).toEqual([id(300), id(305)]);
    });

    test('a swipe left on the text goes to the next Part; a swipe right goes back', async ({ page }) => {
      const served = await openByAddress(page, { parts: 3 });
      const text = await page.getByTestId('stop-scroller').boundingBox();
      if (text === null) throw new Error('the text is on the page');
      // The first Part has none before it.
      await swipe(page, text, 0.15, 0.85);
      await page.waitForTimeout(300);
      expect(opened(served)).toEqual([id(300)]);

      await swipe(page, text, 0.85, 0.15);
      await expect(title(page, 2)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/scroll/${id(301)}$`));
      await swipe(page, text, 0.15, 0.85);
      await expect(title(page, 1)).toBeVisible();
    });
  });
});

test.describe('a Scroll opened from Explore', () => {
  test('the dock has Ask, the sparks, ••• and Part 2, and the end names the related move too', async ({ page }) => {
    await openFromExplore(page);
    await expect(page.getByRole('button', { name: 'Ask about this' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
    await expect(dock(page)).toHaveText('Part 2');
    await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Another related explanation/ })).toBeVisible();
  });
});

const desktop = { width: 1440, height: 900 };

/** ••• then Share: one sheet, and the way to a conversation is reachable (#548). */
async function shareFromMore(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  // The More sheet has stepped aside: only the Share sheet is open, so a tap lands on it.
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send to a conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Send to a conversation' })).toBeVisible();
}

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
  test('a Scroll with a stage says the reader built a picture; a plain Scroll does not', async ({ page }) => {
    await openByAddress(page, { parts: 1 });
    await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The picture you built' })).toBeVisible();

    await openByAddress(page, { parts: 1 }, { document: plain });
    await expect(page.getByTestId('stage')).toHaveCount(0);
    await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
    await expect(page.getByTestId('end-tray')).toBeVisible();
    await expect(page.getByText('The picture you built')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'The short version' })).toBeVisible();
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

test.describe('a tap on a call option after a swipe', () => {
  test.use({ hasTouch: true });

  /**
   * One finger on the page, in the browser's own touch events. The browser drops the first tap that follows a
   * synthesised drag (it reports the touch but makes no click), on any page and with no app code, so the
   * helper makes that first tap on a place that does nothing. The tap the test cares about is the one after it.
   */
  async function tapAfterDrag(page: Page, drag: (page: Page) => Promise<void>) {
    await drag(page);
    const stage = await page.getByTestId('stage').boundingBox();
    if (stage === null) throw new Error('the stage is on the page');
    const cdp = await page.context().newCDPSession(page);
    const tapAt = async (x: number, y: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(400);
    };
    await tapAt(stage.x + 12, stage.y + stage.height / 2);
    // Where the option is now, after the text has settled: a person taps what they see.
    const option = await page.getByRole('radio', { name: /Earth is closer/ }).boundingBox();
    if (option === null) throw new Error('the option is on the page');
    await tapAt(option.x + option.width / 2, option.y + option.height / 2);
    await cdp.detach();
  }

  for (const [name, drag] of [
    ['a swipe left on the text', (page: Page) => swipeOn(page, 'stop-scroller', 0.85, 0.15)],
    ['a swipe up on the text', (page: Page) => swipeUp(page)],
  ] as const) {
    test(`is not swallowed by ${name} (the reader's responder and its scroll-settle leave the next tap alone)`, async ({
      page,
    }) => {
      await openByAddress(page, { parts: 1 });
      await page.getByRole('button', { name: /^Call it 1 of 3/ }).click();
      await page.waitForTimeout(700);
      await tapAfterDrag(page, drag);
      await expect(page.getByRole('radio', { name: /Earth is closer/ })).toBeChecked();
    });
  }
});

async function swipeOn(page: Page, testId: string, from: number, to: number) {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error('the text is on the page');
  await swipe(page, box, from, to);
}

async function swipeUp(page: Page) {
  const box = await page.getByTestId('stop-scroller').boundingBox();
  if (box === null) throw new Error('the text is on the page');
  const x = box.x + box.width / 2;
  await fingerDrag(page, { x, y: box.y + box.height * 0.8 }, { x, y: box.y + box.height * 0.8 - 40 });
}

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
