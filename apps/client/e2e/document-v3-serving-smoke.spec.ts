import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { anchorIsMoment, beatsOfV3, describePicture, momentOfBeat, coverFrameOfV3 } from '@knowscroll/scroll-model';
import type { ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { encounterFixture, id, readCover, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * A document v3 Scroll as the client now asks for it and serves it on (#763), in the production export over labelled
 * HTTP fixtures (no backend): the app declares `scroll-document.v3` and `offer-cover.v2`; an offer whose cover is a
 * picture is drawn as a cover and opens into the essay; and a beat is what a v2 Scroll's stop is to every move that names
 * a place (Ask, Quick answer, the kept place, Share a moment, Report), while Challenge and the Ask puzzle, which need a
 * call, are not offered. The document is the labelled CI fixture `seasons-v3-ci`; the answers are authored in
 * `encounter-fixture.ts`, so this proves what the page sends and shows, not what the server decides
 * (`tests/integration/modules/scroll-v3-serving.test.ts` is the server).
 */
const pictured = seasons as unknown as ScrollDocumentV3;
const beats = beatsOfV3(pictured);
const frame = coverFrameOfV3(pictured);
if (frame === undefined) throw new Error('the fixture shows a picture');
const coverWords = describePicture(frame.picture, frame.state);
const suggestions = pictured.askSuggestions;

const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const viewports = [
  { label: '390 x 844', viewport: phone },
  { label: '1440 x 900', viewport: desktop },
] as const;
const HAND = 3;

type Served = Awaited<ReturnType<typeof encounterFixture>>;
const callsTo = (served: Served, path: string) => served.commands.filter((command) => command.path === path);

async function seriousViolations(page: Page) {
  // A cover draws its picture in and a sheet rises; both are measured once they have stopped.
  await page.waitForTimeout(700);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

const cover = (page: Page) => page.getByTestId('essay-cover');
const scroller = (page: Page) => page.getByTestId('folio-scroller');
const readerTitle = (page: Page) =>
  page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' });

/** Explore on the labelled document v3 Scroll, up to its cover. */
async function openCovers(
  page: Page,
  viewport: { width: number; height: number },
  options: EncounterFixtureOptions = {},
) {
  const served = await encounterFixture(page, 'scroll', {
    covers: { hand: HAND },
    scrollDocument: seasons as unknown as Record<string, unknown>,
    viewport,
    ...options,
  });
  await page.goto('/explore');
  await expect(cover(page)).toBeVisible();
  return served;
}

/** Explore on the Scroll itself, past its cover and the first-arrival note. */
async function openEssay(page: Page, viewport = phone, options: EncounterFixtureOptions = {}) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    ...options,
  });
  await page.goto('/explore');
  await readCover(page);
  await expect(readerTitle(page)).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

/** The Scroll on its own address, which has no encounter and no session. */
async function openDirect(page: Page, viewport = phone, options: EncounterFixtureOptions = {}) {
  const served = await encounterFixture(page, 'scroll', {
    viewport,
    direct: { parts: 1 },
    scrollDocument: seasons as unknown as Record<string, unknown>,
    ...options,
  });
  await page.goto(`/scroll/${id(300)}`);
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  await expect(scroller(page)).toBeVisible();
  return served;
}

/**
 * Brings one beat to the reading band (42 % down the scroller), which is where Folio reads a beat from, and waits for the
 * reader to have taken the scroll in.
 */
async function readBeat(page: Page, beatId: string) {
  await scroller(page).evaluate((node, target) => {
    const beat = node.querySelector(`[data-ks-stop="${target}"]`);
    if (beat === null) throw new Error(`the essay has beat ${target}`);
    const band = Math.round(node.clientHeight * 0.42);
    node.scrollTop += beat.getBoundingClientRect().top - node.getBoundingClientRect().top - band + 1;
  }, beatId);
  await expect(page.getByRole('progressbar', { name: 'How far you have read' })).not.toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  await page.waitForTimeout(250);
}

async function openAsk(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
}

const asked = (served: Served) => callsTo(served, '/v1/content/requests');

test.describe('a cover whose figure is a picture (offer-cover.v2)', () => {
  for (const { label, viewport } of viewports) {
    test(`is drawn as a cover with its picture, asks for nothing to be opened, and opens into the essay, at ${label}`, async ({
      page,
    }) => {
      const served = await openCovers(page, viewport);
      await expect(cover(page).getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
      await expect(cover(page).getByText('CI cover kicker 1', { exact: true })).toBeVisible();
      // The picture is drawn by the general renderer and named by its own words.
      const plate = page.getByTestId('essay-cover-figure');
      await expect(plate).toBeVisible();
      await expect(plate.getByRole('img', { name: coverWords, exact: true })).toBeVisible();
      // A cover has nothing to operate: no Text chip, no control.
      await expect(cover(page).getByRole('button', { name: 'Text version of this picture' })).toHaveCount(0);
      await expect(cover(page).getByTestId('picture-control-scrub')).toHaveCount(0);
      // Both the document and the cover were asked for in the versions this client draws.
      expect(callsTo(served, '/v1/experience/open')[0]?.body.capabilities).toMatchObject({
        documentSchemas: expect.arrayContaining(['scroll-document.v3', 'offer-cover.v1', 'offer-cover.v2']),
      });
      // Looking at a cover is not reading.
      expect(callsTo(served, '/v1/experience/activate')).toHaveLength(0);
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByTestId('essay-cover-read').click();
      await expect(readerTitle(page)).toBeVisible();
      await expect(scroller(page)).toBeVisible();
      await expect(cover(page)).toHaveCount(0);
      expect(callsTo(served, '/v1/experience/activate')).toHaveLength(1);
      // The essay draws the same picture the cover showed.
      await expect(scroller(page).getByRole('img', { name: coverWords, exact: true }).first()).toBeAttached();
    });
  }

  test('draws its picture in no motion at all under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCovers(page, phone);
    const plate = page.getByTestId('essay-cover-figure');
    await expect(plate.getByRole('img', { name: coverWords, exact: true })).toBeVisible();
    await page.waitForTimeout(600);
    expect(await plate.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  });

  test('drops the picture where the screen leaves it no room, and still offers Read and the next cover', async ({
    page,
  }) => {
    await openCovers(page, { width: 320, height: 480 });
    await page.waitForTimeout(600);
    await expect(page.getByTestId('essay-cover-figure')).toHaveCount(0);
    await expect(page.getByTestId('essay-cover-read')).toBeVisible();
    await expect(page.getByTestId('essay-cover-next')).toBeVisible();
  });
});

test.describe('Ask from here on a document v3 Scroll', () => {
  for (const { label, viewport } of viewports) {
    test(`from ••• in Explore sends the question anchored to the beat on screen, at ${label}`, async ({ page }) => {
      const served = await openEssay(page, viewport);
      const beat = beats[4]!;
      await readBeat(page, beat.id);
      await openAsk(page);
      const sheet = page.getByRole('dialog', { name: 'Ask for something' });
      await expect(sheet.getByText('FROM WHAT YOU JUST READ')).toBeVisible();
      // The questions are the Scroll's own, as for a v2 Scroll.
      for (const question of suggestions)
        await expect(sheet.getByRole('button', { name: `Ask: ${question}` })).toBeVisible();
      await sheet.getByRole('button', { name: `Ask: ${suggestions[0]}` }).click();
      await expect(page.getByTestId('ask-making')).toBeVisible();
      expect(asked(served)).toHaveLength(1);
      const body = asked(served)[0]!.body as {
        intent: { kind: string; anchor: { kind: string; stopId: string }; source: Record<string, unknown> };
      };
      // The anchor is the beat's id, the same field a stop's id fills.
      expect(body.intent).toMatchObject({ kind: 'ask', anchor: { kind: 'stop', stopId: beat.id } });
      expect(Object.keys(body.intent.source).sort()).toEqual(['assetId', 'assetRevision', 'exposureId', 'session']);
      // A v3 Scroll has no call, so the wait has no puzzle.
      await expect(page.getByTestId('ask-puzzle')).toHaveCount(0);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test('on the Scroll’s own address ••• offers the same Ask, anchored to the beat on screen', async ({ page }) => {
    const served = await openDirect(page);
    const beat = beats[9]!;
    await readBeat(page, beat.id);
    await openAsk(page);
    const sheet = page.getByRole('dialog', { name: 'Ask' });
    await expect(sheet.getByText('FROM WHAT YOU JUST READ')).toBeVisible();
    await sheet.getByRole('button', { name: `Ask: ${suggestions[1]}` }).click();
    await expect(page.getByTestId('ask-making')).toBeVisible();
    expect(asked(served)).toHaveLength(1);
    const body = asked(served)[0]!.body as { intent: { anchor: { stopId: string }; source: Record<string, unknown> } };
    expect(body.intent.anchor.stopId).toBe(beat.id);
    expect(Object.keys(body.intent.source).sort()).toEqual(['assetId', 'assetRevision', 'exposureId']);
    await expect(page.getByTestId('ask-puzzle')).toHaveCount(0);
  });

  test('at the end of the Scroll, where no beat is on screen, the question is anchored to the last beat', async ({
    page,
  }) => {
    const served = await openDirect(page);
    await page.getByRole('group', { name: 'Scroll reader' }).focus();
    await page.keyboard.press('End');
    await expect(page.getByTestId('end-plate')).toBeInViewport();
    await openAsk(page);
    await page
      .getByRole('dialog', { name: 'Ask' })
      .getByRole('button', { name: `Ask: ${suggestions[0]}` })
      .click();
    await expect(page.getByTestId('ask-making')).toBeVisible();
    const body = asked(served)[0]!.body as { intent: { anchor: { stopId: string } } };
    expect(body.intent.anchor.stopId).toBe(beats.at(-1)!.id);
  });

  test('offers no Challenge, and no empty button where it would be', async ({ page }) => {
    await openEssay(page);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet.getByRole('button', { name: 'Ask about this', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Challenge/ })).toHaveCount(0);
    // Every control of the sheet has a name.
    for (const button of await sheet.getByRole('button').all()) {
      expect(((await button.getAttribute('aria-label')) ?? (await button.innerText())).trim()).not.toBe('');
    }
    await page.keyboard.press('Escape');
    // The key for Challenge does nothing either: no sheet opens.
    await page.getByRole('group', { name: 'Scroll reader' }).focus();
    await page.keyboard.press('c');
    await expect(page.getByRole('dialog', { name: 'Challenge a friend' })).toHaveCount(0);
  });
});

test('selected words on a beat ask a Quick answer anchored to that beat', async ({ page }) => {
  const served = await openEssay(page);
  const beat = beats[1]!;
  await readBeat(page, beat.id);
  const words = beat.text.split(' ')[2]!.replace(/[^A-Za-z]/g, '');
  await page.evaluate(
    ({ stop, wanted }) => {
      const root = document.querySelector(`[data-ks-stop="${stop}"]`);
      if (root === null) throw new Error(`no beat ${stop}`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error(`no words "${wanted}" in ${stop}`);
    },
    { stop: beat.id, wanted: words },
  );
  await page.getByRole('toolbar', { name: 'Selected text' }).getByRole('button', { name: 'Ask' }).click();
  const card = page.locator(`[data-ks-stop="${beat.id}"]`).getByTestId('quick-answer-card');
  await expect(card.getByTestId('quick-answer-label')).toHaveText('QUICK ANSWER · NOT A CHECKED SCROLL');
  const sent = callsTo(served, '/v1/quick-answers');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ version: 'quick-answer-ask.v1', stopId: beat.id, passage: words });
});

test('the place kept is the beat the reader was on: a reload opens the Scroll where it was left', async ({ page }) => {
  await openDirect(page);
  const beat = beats[9]!;
  await readBeat(page, beat.id);
  await page.reload();
  await expect(scroller(page)).toBeVisible();
  const placed = page.locator(`[data-ks-stop="${beat.id}"]`);
  await expect(placed).toBeInViewport();
  // The first beat, which is where an unplaced Scroll opens, is no longer in view.
  await expect(page.locator(`[data-ks-stop="${beats[0]!.id}"]`)).not.toBeInViewport();
});

test.describe('Share a moment on a document v3 beat', () => {
  const peer = { kind: 'person', personId: id(11), handle: 'ci.ravi', displayName: 'Ravi fixture' };
  const scope = { accountId: id(1), privacyEpoch: 1 };
  const thread = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };

  /** Explore on the Scroll with one joined thread whose series holds it, and the send captured. */
  async function openWithThread(page: Page, viewport: { width: number; height: number }) {
    const sent: Record<string, unknown>[] = [];
    await encounterFixture(page, 'scroll', {
      viewport,
      scrollDocument: seasons as unknown as Record<string, unknown>,
    });
    await page.route('**/v1/social/threads/inbox', (route) =>
      route.fulfill({
        json: {
          version: 'content-thread.v1',
          readId: (route.request().postDataJSON() as { readId: string }).readId,
          scope,
          status: 'ready',
          limit: 50,
          viewRevision: 1,
          items: [
            {
              thread,
              name: 'Seasons with Ravi',
              root: { status: 'unavailable' },
              state: 'joined',
              ownPersonId: id(10),
              people: [peer],
              latestMessageSequence: 0,
              own: { readThroughSequence: 0 },
              lastActivityAt: '2026-11-01T10:00:00.000Z',
            },
          ],
        },
      }),
    );
    await page.route('**/v1/social/threads/read', (route) => {
      const body = route.request().postDataJSON() as { readId: string };
      return route.fulfill({
        json: {
          version: 'content-thread.v1',
          readId: body.readId,
          scope,
          status: 'ready',
          thread,
          episodes: [
            { assetId: id(300), assetRevision: 1, kind: 'scroll', title: 'A Scroll', state: 'ready', visited: false },
          ],
        },
      });
    });
    await page.route('**/v1/social/threads/send', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      sent.push(body);
      await route.fulfill({
        json: {
          version: 'content-thread.v1',
          scope,
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'thread.send',
          thread,
          messageId: id(8000),
          messageSequence: 1,
          sent: { kind: 'snippet', anchor: 'scroll_passage' },
        },
      });
    });
    await page.goto('/explore');
    await readCover(page);
    await expect(readerTitle(page)).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    return sent;
  }

  for (const { label, viewport } of viewports) {
    test(`shows the beat’s words and no picture, and sends the beat as the moment, at ${label}`, async ({ page }) => {
      const sent = await openWithThread(page, viewport);
      const beat = beats[5]!;
      await readBeat(page, beat.id);
      // The dock's Share is the moment of the beat on screen: a v3 Scroll has no call to make it the whole Scroll.
      await page
        .getByTestId('reader-dock')
        .getByRole('button', { name: /^Share a moment/ })
        .click();
      const sheet = page.getByRole('dialog', { name: 'Share a moment' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('moment-preview')).toBeVisible();
      await expect(sheet.getByTestId('moment-quote')).toContainText(beat.text.slice(0, 40));
      // A moment of a v3 Scroll carries no picture: not before a thread is chosen, and not after.
      await expect(sheet.getByTestId('moment-picture')).toHaveCount(0);
      await expect(sheet.getByRole('img')).toHaveCount(0);
      await sheet.getByRole('button', { name: 'Seasons with Ravi' }).click();
      await expect(sheet.getByText('To · Seasons with Ravi')).toBeVisible();
      await expect(sheet.getByTestId('moment-picture')).toHaveCount(0);
      expect(await seriousViolations(page)).toEqual([]);
      await sheet.getByTestId('moment-share').click();
      await expect(sheet.getByText('Shared.')).toBeVisible();
      expect(sent).toHaveLength(1);
      const body = sent[0]!['body'] as {
        kind: string;
        anchor: { kind: string; blockId: string; start: number; end: number; quoteHash: string };
      };
      expect(body.kind).toBe('snippet');
      // The anchor names the beat and hashes its words; it carries none of them.
      expect(body.anchor.kind).toBe('scroll_passage');
      expect(body.anchor.blockId).toBe(beat.id);
      expect(anchorIsMoment(momentOfBeat(pictured, beat.id)!, body.anchor)).toBe(true);
      expect(JSON.stringify(sent[0])).not.toContain(beat.text.slice(0, 20));
    });
  }
});

test('Report from ••• names the beat on screen', async ({ page }) => {
  const served = await openEssay(page);
  const beat = beats[2]!;
  await readBeat(page, beat.id);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Report' });
  await expect(sheet.getByRole('heading', { name: 'Report an error' })).toBeVisible();
  await sheet.getByRole('button', { name: /^Send/ }).click();
  await expect.poll(() => callsTo(served, '/v1/feedback/content-errors').length).toBe(1);
  expect(callsTo(served, '/v1/feedback/content-errors')[0]!.body).toMatchObject({
    anchor: { kind: 'scroll', blockId: beat.id },
  });
});
