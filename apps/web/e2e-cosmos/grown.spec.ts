import { join } from 'node:path';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { expect, test } from '../e2e/support/origin.ts';
import {
  ARTIFACTS_DIR,
  expectHitArea,
  expectInsideViewport,
  expectNoHorizontalScroll,
  instrument,
  originFlag,
  readOriginLog,
} from './support.ts';

/**
 * ADR-0051 §1–§5, against a GROWN disposable stack (scripts/run-web-cosmos-preview.ts --grow): the
 * universe was read into shape through the real HTTP API, so Gravity and Tides are live top-level
 * places (stars), Gravity explains Tides (a sourced relation, drawn as a constellation line), and a
 * question the reader carried on two days opened a room (a question world) on each. Its Traces make
 * this a returning reader. The Atlas itself is read through the same Vite dev-auth proxy the page
 * uses, so every star asserted here is checked against what the server says exists.
 *
 * Reading from a star records exposures but never a Keep, so every test sees the same stars. Each
 * test has its own browser context: a Scroll already read from Gravity in one trip is (rightly)
 * excluded from the next ask in that trip, so a second "Read from Gravity" belongs in a new one.
 */
interface AtlasPlace {
  placeId: string;
  kind: 'planet' | 'region' | 'sighting';
  anchor: { name: string };
  rooms: { question: string }[];
}

async function liveStars(request: APIRequestContext): Promise<AtlasPlace[]> {
  const response = await request.get('/v1/atlas?webReader=v1');
  expect(response.status()).toBe(200);
  const atlas = (await response.json()) as { places: AtlasPlace[] };
  return atlas.places.filter(place => place.kind === 'planet');
}

async function gravity(request: APIRequestContext): Promise<AtlasPlace> {
  const star = (await liveStars(request)).find(place => place.anchor.name === 'Gravity');
  expect(star, 'the grown universe has Gravity as a live star').toBeDefined();
  return star!;
}

const starsNav = (page: Page) => page.getByRole('navigation', { name: 'Your stars' });
const starButton = (page: Page, name: string) =>
  starsNav(page).getByRole('button', { name: new RegExp(`^${name}: .*Approach this star\\.$`) });
const system = (page: Page, name: string) => page.getByRole('region', { name: `${name}, a star in your universe` });

/** Resolves with the feed request the page sends while asking from `placeId`. */
function feedFrom(page: Page, placeId: string): Promise<Request> {
  return page.waitForRequest(request => {
    if (request.method() !== 'GET' || !request.url().includes('/v1/feed')) return false;
    return new URL(request.url()).searchParams.get('place') === placeId;
  });
}

async function expectScrollFrom(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('article')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.head-band-origin')).toHaveText(`From ${name} · read from your sky`);
}

test.describe('a grown universe: stars, a star system, worlds', () => {
  test('the sky shows exactly the live stars by name, joined by their constellation line', async ({ page, request }) => {
    const stars = await liveStars(request);
    const names = stars.map(star => star.anchor.name).sort();
    expect(names).toEqual(['Gravity', 'Tides']);

    await page.goto('/');
    await expect(starsNav(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your sky, so far.' })).toBeVisible();
    await expect(starsNav(page).getByRole('button')).toHaveCount(names.length);
    for (const name of names) {
      await expect(starButton(page, name)).toBeVisible();
      await expect(starButton(page, name).locator('.body-name')).toHaveText(name);
    }
    // A formed universe no longer offers the unformed seed of a first visit.
    await expect(page.locator('[data-origin-target]')).toHaveCount(0);

    // The relation Gravity -> Tides is a line whose ends sit on those two stars.
    const lines = page.locator('.sky-constellations line');
    await expect(lines).not.toHaveCount(0);
    const ends = await lines.first().evaluate(line => [
      [Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))],
      [Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))],
    ]);
    const centres = await Promise.all(
      names.map(name => starButton(page, name).evaluate(button => {
        const style = (button as HTMLElement).style;
        return [parseFloat(style.left), parseFloat(style.top)];
      })),
    );
    const key = (point: number[]) => point.map(value => value.toFixed(2)).join(',');
    expect(ends.map(key).sort()).toEqual(centres.map(key).sort());
    await page.screenshot({ path: join(ARTIFACTS_DIR, 'grown-universe-desktop-1280x720.png') });
  });

  test('approaching Gravity explains it, and Read from Gravity opens a Scroll from that star', async ({ page, request }) => {
    const star = await gravity(request);
    await page.goto('/');
    await starButton(page, 'Gravity').click();
    const gravitySystem = system(page, 'Gravity');
    await expect(gravitySystem).toBeVisible();
    await expect(gravitySystem.getByRole('heading', { level: 2, name: 'Gravity' })).toBeVisible();
    const why = gravitySystem.getByRole('region', { name: 'Why it looks like this' });
    await expect(why).toBeVisible();
    const reasons = why.getByRole('listitem');
    await expect(reasons).not.toHaveCount(0);
    for (const reason of await reasons.allInnerTexts()) expect(reason.trim().length).toBeGreaterThan(0);
    // The question world in the sheet is the room the server recorded on Gravity.
    const question = star.rooms[0]?.question;
    expect(question, 'Gravity has a room (a question world)').toBeTruthy();
    await expect(gravitySystem.getByRole('button', { name: `Land on the question world: ${question}` })).toBeVisible();
    await page.waitForTimeout(600); // let the approach settle for the record
    await page.screenshot({ path: join(ARTIFACTS_DIR, 'grown-star-system-desktop-1280x720.png') });

    const asked = feedFrom(page, star.placeId);
    await gravitySystem.getByRole('button', { name: 'Read from Gravity' }).first().click();
    await asked;
    await expectScrollFrom(page, 'Gravity');

    await page.getByRole('button', { name: 'Return to Universe' }).first().click();
    await expect(starsNav(page)).toBeVisible();
    await expect(starButton(page, 'Gravity')).toBeVisible();
  });

  test.describe('landing on a world', () => {
    // Reduced motion: the globe does not turn by itself, so a change proves the reader turned it.
    test.use({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });

    test("land on Gravity's question world, turn it, change its light, then read from Gravity", async ({ page, request }) => {
      const star = await gravity(request);
      const question = star.rooms[0]!.question;
      await page.goto('/');
      await starButton(page, 'Gravity').click();
      await system(page, 'Gravity').getByRole('button', { name: `Land on the question world: ${question}` }).click();

      const landing = page.getByRole('region', { name: 'Planet landing' });
      await expect(landing).toBeVisible();
      await expect(landing.getByText('A question world in Gravity')).toBeVisible();
      await expect(landing.getByRole('heading', { level: 1 })).toHaveText(question);

      const planet = landing.getByRole('button', { name: /Rotate planet/ });
      const before = await planet.getAttribute('style');
      const bounds = await planet.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(bounds!.x + bounds!.width * 0.35, bounds!.y + bounds!.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(bounds!.x + bounds!.width * 0.65, bounds!.y + bounds!.height * 0.5, { steps: 5 });
      await page.mouse.up();
      expect(await planet.getAttribute('style')).not.toBe(before);
      await expect(landing.getByText('Daylight')).toBeVisible();
      await planet.click();
      await expect(landing.getByText('Evening glow')).toBeVisible();
      await landing.getByRole('button', { name: /Advance the moon/ }).click();
      await expect(landing.getByText('Moonlit')).toBeVisible();
      await page.screenshot({ path: join(ARTIFACTS_DIR, 'grown-landing-phone-390x844.png') });

      const read = landing.getByRole('button', { name: /^Read from Gravity/ });
      await expect(read).toBeInViewport();
      const asked = feedFrom(page, star.placeId);
      await read.click();
      await asked;
      await expectScrollFrom(page, 'Gravity');
    });
  });

  test.describe('on a phone (390 × 844, touch)', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

    test('the Universe and a star system fit the screen, and every star is a 44 px target', async ({ page }) => {
      await page.goto('/');
      await expect(starsNav(page)).toBeVisible();
      await expectNoHorizontalScroll(page, 'grown Universe on a phone');
      const stars = starsNav(page).getByRole('button');
      await expect(stars).toHaveCount(2);
      for (const button of await stars.all()) {
        const label = (await button.getAttribute('aria-label')) ?? 'a star';
        await expectHitArea(button, label);
        await expectInsideViewport(page, button, label);
      }
      await page.screenshot({ path: join(ARTIFACTS_DIR, 'grown-universe-phone-390x844.png') });

      await starButton(page, 'Gravity').tap();
      const gravitySystem = system(page, 'Gravity');
      await expect(gravitySystem).toBeVisible();
      const heading = gravitySystem.getByRole('heading', { level: 2, name: 'Gravity' });
      await expect(heading).toBeVisible();
      await expect(heading).toBeInViewport();
      await expectNoHorizontalScroll(page, 'star system on a phone');
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(ARTIFACTS_DIR, 'grown-star-system-phone-390x844.png') });
    });
  });

  test.describe('a returning reader in a browser that has not seen the opening', () => {
    test.use({ originSeen: false });

    test('the opening never plays: it gives way at once, and never appears again in this browser', async ({ page, context }) => {
      await instrument(context);
      await page.goto('/');
      await expect(starsNav(page)).toBeVisible();
      await expect(page.getByTestId('origin')).toHaveCount(0, { timeout: 2_000 });
      await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');

      // Until the Universe answered, this browser could not know the reader was returning: the
      // overlay held a dark frame, then stepped aside on the "returning" path before any of the story.
      const first = await readOriginLog(page);
      expect(first.captions, 'no words of the opening were shown').toEqual([]);
      expect(first.controlsShown, 'no Skip or Sound control was ever shown').toBe(false);
      const attach = first.events.find(event => event.type === 'attach');
      const detach = first.events.find(event => event.type === 'detach');
      if (attach) {
        expect(detach, 'the overlay left').toBeDefined();
        expect(detach!.className, 'it left on the returning path').toMatch(/origin--leaving/);
        const shownFor = detach!.at - attach.at;
        test.info().annotations.push({ type: 'returning-overlay-ms', description: shownFor.toFixed(0) });
        expect(shownFor, 'it stepped aside at once').toBeLessThan(1_500);
      }
      expect(await originFlag(page)).toBe('seen');

      // This browser now knows the reader. Even with the "seen" flag removed, the observed universe
      // alone keeps the opening from ever mounting again.
      await page.evaluate(() => localStorage.removeItem('ks_origin_v1'));
      await page.reload();
      await expect(starsNav(page)).toBeVisible();
      await expect(starButton(page, 'Gravity')).toBeVisible();
      expect((await readOriginLog(page)).events, 'the overlay never attached in the reloaded document').toEqual([]);
      await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
    });
  });
});
