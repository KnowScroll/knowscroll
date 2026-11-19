import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import broadStreet from '@knowscroll/scroll-model/fixtures/broad-street-v3-ci.json';
import fence from '@knowscroll/scroll-model/fixtures/fence-v3-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { describePicture, type ScrollDocumentV3 } from '@knowscroll/scroll-model';

/**
 * Folio drawing a `scroll-document.v3` in a real browser (the gallery export, `/gallery-folio`, the three labelled CI
 * fixtures `fenceV3`, `seasonsV3` and `broadStreetV3`, #762): what a reader sees and does. Each essay shows its section
 * headings and the "Fixture" kicker and draws its first picture, in Light and Dark, on a phone and a desktop, with no
 * sideways scroll and nothing serious for an accessibility scan; at 320 px wide and at 200 % text nothing scrolls
 * sideways either. The Text chip, a linked phrase, the three controls (scrub, switch, pick), "To sum up" and reduced
 * motion are each checked on the fixture that has them. The words a person reads come from the fixtures, not from the
 * spec, so a change to a fixture's text does not break it.
 */

const documents = {
  fence: { query: 'fenceV3', document: fence as unknown as ScrollDocumentV3 },
  seasons: { query: 'seasonsV3', document: seasons as unknown as ScrollDocumentV3 },
  'broad-street': { query: 'broadStreetV3', document: broadStreet as unknown as ScrollDocumentV3 },
} as const;
type Name = keyof typeof documents;
const names = Object.keys(documents) as Name[];

const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const sizes = [
  { label: 'phone', viewport: phone },
  { label: 'desktop', viewport: desktop },
] as const;
const appearances = ['light', 'dark'] as const;

type Viewport = { width: number; height: number };
interface Options {
  readonly appearance?: (typeof appearances)[number];
  readonly scale?: '2';
  readonly motion?: 'reduce';
}

const scroller = (page: Page) => page.getByTestId('folio-scroller');

/** Opens the gallery on one fixture as a reader sees it (no fixture toolbar), in an appearance, and waits for the essay to settle. */
async function open(page: Page, name: Name, viewport: Viewport, options: Options = {}) {
  const { appearance = 'light', scale, motion } = options;
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    ['ks.device.preferences', JSON.stringify({ appearance })] as const,
  );
  if (motion === 'reduce') await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(viewport);
  const query = new URLSearchParams({
    doc: documents[name].query,
    bare: '1',
    ...(scale === undefined ? {} : { scale }),
    ...(motion === undefined ? {} : { motion }),
  });
  await page.goto(`/gallery-folio?${query.toString()}`);
  await expect(page.getByTestId('ks-folio-gallery')).toBeVisible();
  await expect(scroller(page).getByRole('heading', { level: 1, name: documents[name].document.title })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
    .toBe(appearance);
  // The essay is laid out when its height stops changing.
  let last = -1;
  await expect
    .poll(async () => {
      const now = await scroller(page).evaluate((node) => node.scrollHeight);
      const settled = now === last;
      last = now;
      return settled;
    })
    .toBe(true);
}

/** Down to the end plate, with the keys a reader has. */
async function toTheEnd(page: Page) {
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('end-plate')).toBeInViewport();
}

/** How far the page and the essay scroll sideways: nothing, for a column that fits. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const essay = document.querySelector('[data-testid="folio-scroller"]') as HTMLElement;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      essay: essay.scrollWidth - essay.clientWidth,
    };
  });

async function expectNoSidewaysScroll(page: Page, where: string) {
  const measured = await sideways(page);
  expect(measured.page, `${where}: the page`).toBeLessThanOrEqual(0);
  expect(measured.essay, `${where}: the essay`).toBeLessThanOrEqual(1);
}

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/** The first beat that shows a picture: the picture, its state and the words the picture says for it. */
function firstFigureOf(document: ScrollDocumentV3) {
  const pictures = new Map(document.pictures.map((picture) => [picture.id, picture]));
  for (const section of document.sections)
    for (const beat of section.beats) {
      const picture = beat.show === undefined ? undefined : pictures.get(beat.show.picture);
      if (beat.show !== undefined && picture !== undefined)
        return { picture, state: beat.show.state, words: describePicture(picture, beat.show.state) };
    }
  throw new Error('a fixture shows a picture');
}

for (const name of names) {
  const { document } = documents[name];
  for (const { label, viewport } of sizes) {
    for (const appearance of appearances) {
      test(`${name} draws its headings, its "Fixture" kicker and its first picture, with no sideways scroll, in ${appearance} at ${label}`, async ({
        page,
      }) => {
        await open(page, name, viewport, { appearance });
        await expect(scroller(page).getByText('Fixture', { exact: true })).toBeVisible();
        for (const section of document.sections) {
          const heading = scroller(page).getByRole('heading', { level: 2, name: section.title, exact: true });
          await heading.scrollIntoViewIfNeeded();
          await expect(heading).toBeVisible();
        }
        await scroller(page).evaluate((node) => {
          node.scrollTop = 0;
        });
        // The picture's words are its accessible name: what a person who cannot see it is told.
        const first = scroller(page)
          .getByRole('img', { name: firstFigureOf(document).words, exact: true })
          .first();
        await first.scrollIntoViewIfNeeded();
        await expect(first).toBeVisible();
        await expectNoSidewaysScroll(page, 'at the top');
        await toTheEnd(page);
        await expectNoSidewaysScroll(page, 'at the end');
      });

      test(`${name} has nothing serious for an accessibility scan, at the top and the end, in ${appearance} at ${label}`, async ({
        page,
      }) => {
        await open(page, name, viewport, { appearance });
        expect(await seriousViolations(page), 'at the top').toEqual([]);
        await toTheEnd(page);
        expect(await seriousViolations(page), 'at the end').toEqual([]);
      });
    }
  }
}

for (const name of names) {
  const cases: { label: string; viewport: Viewport; options: Options }[] = [
    { label: '320 x 640', viewport: { width: 320, height: 640 }, options: {} },
    { label: '200 % text at 390 x 844', viewport: phone, options: { scale: '2' } },
    { label: '200 % text at 320 x 640', viewport: { width: 320, height: 640 }, options: { scale: '2' } },
  ];
  for (const { label, viewport, options } of cases) {
    test(`${name} does not scroll sideways at ${label}, all the way down`, async ({ page }) => {
      await open(page, name, viewport, options);
      await expect(scroller(page).getByRole('heading', { level: 1 })).toBeInViewport();
      await expectNoSidewaysScroll(page, 'at the top');
      const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
      for (let top = 0; top <= most; top += 400) {
        await scroller(page).evaluate((node, value) => {
          node.scrollTop = value;
        }, top);
        await expectNoSidewaysScroll(page, `${String(top)} px down`);
      }
      await toTheEnd(page);
      await expectNoSidewaysScroll(page, 'at the end');
    });
  }
}

for (const name of names) {
  const { document } = documents[name];
  test(`the Text chip of ${name}'s first picture shows its words in place of the picture, and turns back`, async ({
    page,
  }) => {
    await open(page, name, phone);
    const { words } = firstFigureOf(document);
    const picture = scroller(page).getByRole('img', { name: words, exact: true }).first();
    await picture.scrollIntoViewIfNeeded();
    const plate = scroller(page).locator('[data-ks-figure]').first();
    const chip = plate.getByRole('button', { name: 'Text version of this picture' });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // The words are on the page as text, and the drawing that spoke them is gone.
    await expect(plate.getByText(words, { exact: true })).toBeVisible();
    await expect(plate.getByRole('img')).toHaveCount(0);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect(plate.getByRole('img', { name: words, exact: true })).toBeVisible();
  });

  test(`a linked phrase of ${name} is a button, and pressing it stays on the page`, async ({ page }) => {
    await open(page, name, phone);
    const linked = document.sections.flatMap((section) => section.beats).find((beat) => beat.links.length > 0);
    const link = linked?.links[0];
    if (linked === undefined || link === undefined) throw new Error('a fixture has a linked phrase');
    const beat = page.getByTestId(`beat-${linked.id}`);
    const phrase = beat.getByRole('button', { name: `Show ${link.phrase} in the picture` });
    await phrase.scrollIntoViewIfNeeded();
    await expect(phrase).toBeVisible();
    await expect(phrase).toHaveText(link.phrase);
    const before = page.url();
    await phrase.click();
    expect(page.url()).toBe(before);
    await expect(phrase).toBeVisible();
    await expect(scroller(page).getByRole('heading', { level: 1 })).toHaveCount(1);
    // By keyboard too: it takes focus and Enter presses it.
    await phrase.focus();
    await expect(phrase).toBeFocused();
    await page.keyboard.press('Enter');
    expect(page.url()).toBe(before);
  });

  test(`"To sum up" at the end of ${name} shows the takeaway`, async ({ page }) => {
    await open(page, name, phone);
    await toTheEnd(page);
    const plate = page.getByTestId('end-plate');
    await expect(plate.getByRole('heading', { level: 2, name: 'To sum up' })).toBeVisible();
    await expect(page.getByTestId('end-summary')).toContainText(document.takeaway.trim().replace(/[.!?…]+$/, ''));
  });
}

test('the scrub control of seasons: Next changes the sentence it announces, and the arrow keys move it', async ({
  page,
}) => {
  await open(page, 'seasons', phone);
  const scrub = page.getByTestId('picture-control-scrub');
  await scrub.scrollIntoViewIfNeeded();
  const sentence = scrub.getByTestId('control-sentence');
  await expect(sentence).not.toHaveText('');
  await expect(sentence).toHaveAttribute('role', 'status');
  const start = (await sentence.textContent()) ?? '';
  const chosen = scrub.getByRole('radio', { checked: true });
  const startLabel = await chosen.innerText();

  await scrub.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(sentence).not.toHaveText(start);
  const afterNext = (await sentence.textContent()) ?? '';
  const nextLabel = await chosen.innerText();
  expect(nextLabel).not.toBe(startLabel);

  await chosen.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sentence).not.toHaveText(afterNext);
  const afterArrow = (await sentence.textContent()) ?? '';
  await page.keyboard.press('ArrowLeft');
  await expect(sentence).not.toHaveText(afterArrow);
  await expect(sentence).toHaveText(afterNext);
  await page.keyboard.press('Home');
  await expect(scrub.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
});

test('the switch of broad-street toggles aria-pressed and the sentence it announces', async ({ page }) => {
  await open(page, 'broad-street', phone);
  const switchBeat = documents['broad-street'].document.sections
    .flatMap((section) => section.beats)
    .find((beat) => beat.kind === 'plain' && beat.control?.kind === 'switch');
  const control = switchBeat?.kind === 'plain' ? switchBeat.control : undefined;
  if (control?.kind !== 'switch') throw new Error('broad-street has a switch');
  const toggle = page.getByRole('button', { name: control.label, exact: true });
  await toggle.scrollIntoViewIfNeeded();
  const sentence = page.getByTestId('picture-control-switch').getByTestId('control-sentence');
  const start = (await sentence.textContent()) ?? '';
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(sentence).not.toHaveText(start);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(sentence).toHaveText(start);
});

test('the pick of the fence shows the note of a cell: "The bull."', async ({ page }) => {
  await open(page, 'fence', phone);
  const pick = page.getByTestId('picture-control-pick');
  await pick.scrollIntoViewIfNeeded();
  const sentence = pick.getByTestId('control-sentence');
  await expect(pick.getByRole('radio', { checked: true })).toHaveCount(0);
  // A cell is named by its row and its column, as the picture's words name it.
  const costs = documents.fence.document.pictures.find((picture) => picture.id === 'costs');
  if (costs?.kind !== 'grid') throw new Error('the fence has a grid of costs');
  const nameOf = (cellId: string) => {
    const cell = costs.cells.find((candidate) => candidate.id === cellId);
    const row = costs.rows.find((candidate) => candidate.id === cell?.row);
    const column = costs.columns.find((candidate) => candidate.id === cell?.column);
    return `${row?.label ?? ''}, ${column?.label ?? ''}`;
  };
  expect(costs.cells.find((cell) => cell.id === 'tear-alive')?.note).toBe('The bull.');
  await pick.getByRole('radio', { name: nameOf('tear-alive'), exact: true }).click();
  await expect(sentence).toContainText('The bull.');
  await expect(pick.getByRole('radio', { checked: true })).toHaveCount(1);
  // Another cell says its own note, and the first is no longer the one chosen.
  await pick.getByRole('radio', { name: nameOf('tear-dead'), exact: true }).click();
  await expect(sentence).not.toContainText('The bull.');
  await expect(sentence).toContainText('Nothing.');
});

for (const { label, viewport } of sizes) {
  test(`under reduced motion the held figure of seasons changes, and nothing glides, at ${label}`, async ({ page }) => {
    await open(page, 'seasons', viewport, { motion: 'reduce' });
    const keys = new Set<string>();
    let gliding = 0;
    const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
    for (let top = 0; top <= most; top += 120) {
      await scroller(page).evaluate((node, value) => {
        node.scrollTop = value;
      }, top);
      // The held figure follows the scroll through React state: give it a frame or two.
      await page.waitForTimeout(150);
      const held = await page.evaluate(() => {
        const plate = document.querySelector('[data-testid="held-figure"] [data-ks-figure]');
        if (plate === null) return undefined;
        return {
          key: plate.getAttribute('data-ks-figure') ?? '',
          animations: plate.getAnimations({ subtree: true }).length,
        };
      });
      if (held !== undefined) {
        keys.add(held.key);
        gliding += held.animations;
      }
    }
    expect(keys.size, 'the held figure took more than one state').toBeGreaterThanOrEqual(2);
    expect(gliding, 'animations running inside a held figure').toBe(0);
  });
}
