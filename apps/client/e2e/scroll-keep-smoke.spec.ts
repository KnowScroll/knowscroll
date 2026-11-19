import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, id } from './encounter-fixture';

/**
 * Save and Share on a Scroll's own address (`/scroll/<id>`, D-429), in the production export over labelled HTTP
 * fixtures (no backend): a pressed Save takes the Scroll out of Saved through the same five-second removal with Undo as
 * everywhere else, what Save could not settle is said on the page and not only inside the ••• sheet, and Share is never
 * a dead button.
 */
const phone = { width: 390, height: 844 };

/** Opens the Scroll's own address; `kept` is whether the Keep reads say it is saved. */
async function openByAddress(page: Page, kept: boolean) {
  const served = await encounterFixture(page, 'scroll', {
    viewport: phone,
    direct: { parts: 1 },
    scrollDocument: seasons as unknown as Record<string, unknown>,
    kept,
  });
  await page.goto(`/scroll/${id(300)}`);
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  return served;
}

const dock = (page: Page) => page.getByTestId('reader-dock');
const removals = (served: Awaited<ReturnType<typeof openByAddress>>) =>
  served.commands.filter((call) => call.path === '/v1/experience/keep/remove');

test('a pressed Save takes the Scroll out of Saved after five seconds with Undo, and the notice is on the page, not in •••', async ({
  page,
}) => {
  const served = await openByAddress(page, true);
  const saved = dock(page).getByRole('button', { name: 'Save', pressed: true });
  await expect(saved).toBeVisible();
  // Frozen test time before the grace starts, so assertion latency cannot use any of the five seconds.
  await page.clock.install({ time: new Date('2026-10-22T06:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-10-22T06:00:01.000Z'));
  await saved.click();
  await expect(page.getByText('Removing from Keep.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
  expect(removals(served)).toHaveLength(0);
  // Undo cancels it: nothing is sent and the Scroll stays saved.
  await page.getByRole('button', { name: 'Undo removal' }).click();
  await page.clock.fastForward(5000);
  expect(removals(served)).toHaveLength(0);
  await expect(dock(page).getByRole('button', { name: 'Save', pressed: true })).toBeVisible();
  // Pressed again and left alone, it goes at five seconds, naming the entry that was read.
  await dock(page).getByRole('button', { name: 'Save', pressed: true }).click();
  await expect(page.getByRole('button', { name: 'Undo removal' })).toBeVisible();
  await page.clock.fastForward(4999);
  expect(removals(served)).toHaveLength(0);
  await page.clock.fastForward(1);
  await expect.poll(() => removals(served).length).toBe(1);
  expect(removals(served)[0]?.body).toMatchObject({
    version: 'keep-remove.v1',
    entry: { assetId: id(300), savedEntryId: id(992) },
  });
  await page.clock.resume();
  await expect(dock(page).getByRole('button', { name: 'Save', pressed: false })).toBeVisible();
});

test('a Save that was not confirmed is said on the page with Retry Save, with the ••• sheet closed', async ({
  page,
}) => {
  await openByAddress(page, false);
  let sent = 0;
  await page.route('**/v1/actions', async (route) => {
    sent += 1;
    await route.fulfill({ status: 500, json: {} });
  });
  await dock(page).getByRole('button', { name: 'Save', pressed: false }).click();
  const notice = page.getByText("Save wasn't confirmed.");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry Save' })).toBeVisible();
  // Retry checks the same save again.
  const before = sent;
  await page.getByRole('button', { name: 'Retry Save' }).click();
  await expect.poll(() => sent).toBeGreaterThan(before);
});

test('Share is never a dead button: at the end of a Scroll it shares the whole Scroll', async ({ page }) => {
  await openByAddress(page, false);
  // Where a moment can be shared, the button says so.
  await expect(dock(page).getByRole('button', { name: 'Share a moment' })).toBeEnabled();
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('end-plate')).toBeVisible();
  // A moment is one stop, and the end is none: the button is still live, and its name says what it will share.
  const share = dock(page).getByRole('button', { name: 'Share this Scroll' });
  await expect(share).toBeEnabled();
  await expect(dock(page).getByText('Share', { exact: true })).toBeVisible();
  await share.click();
  const sheet = page.getByRole('dialog', { name: 'Share' });
  await expect(sheet.getByRole('button', { name: 'Send to a conversation' })).toBeVisible();
});
