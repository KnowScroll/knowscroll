import { expect, test } from '@playwright/test';

/**
 * The gallery export (EXPO_PUBLIC_KS_GALLERY=1, never shipped): the gallery is present under its
 * stable marker (the positive control for the production check), and the overlay and switch
 * primitives behave in a real browser.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('the gallery build carries the gallery under its stable marker', async ({ page }) => {
  await page.goto('/gallery');
  await expect(page.getByTestId('ks-component-gallery')).toBeVisible();
  await expect(page).toHaveTitle('Component gallery · KnowScroll');
});

test('the sheet is one labelled modal dialog; Esc closes it and focus returns', async ({ page }) => {
  await page.goto('/gallery');
  const opener = page.getByRole('button', { name: 'Open a sheet' });
  await opener.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Share' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);

  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/gallery');
});

test('browser Back with the sheet open closes the sheet only (N01)', async ({ page }) => {
  await page.goto('/explore');
  await page.goto('/gallery');
  await page.getByRole('button', { name: 'Open a sheet' }).click();
  await expect(page.getByRole('dialog', { name: 'Share' })).toBeVisible();

  await page.evaluate(() => {
    history.back();
  });

  await expect(page.getByRole('dialog', { name: 'Share' })).toHaveCount(0);
  await expect(page.getByTestId('ks-component-gallery')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/gallery');
});

test('the format switch is a radio group: one Tab stop, arrow keys choose', async ({ page }) => {
  await page.goto('/gallery');
  const group = page.getByRole('radiogroup', { name: 'Format of this explanation' }).first();
  const reel = group.getByRole('radio', { name: 'Reel', exact: true });
  const scroll = group.getByRole('radio', { name: 'Scroll', exact: true });
  await expect(reel).toBeChecked();
  await expect(scroll).toHaveAttribute('tabindex', '-1');

  await reel.focus();
  await page.keyboard.press('ArrowRight');

  await expect(scroll).toBeChecked();
  await expect(scroll).toBeFocused();
  await expect(reel).not.toBeChecked();
});

test('pressed toggles are cobalt on paper, never the continuation yellow (D-006 b)', async ({ page }) => {
  await page.goto('/gallery');
  const pressed = page.getByRole('button', { name: 'Like', exact: true, pressed: true }).first();
  await expect(pressed).toHaveCSS('background-color', 'rgb(44, 70, 232)');
});
