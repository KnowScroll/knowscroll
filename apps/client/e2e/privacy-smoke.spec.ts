import { expect, test } from '@playwright/test';
import { signedInAccount } from './account-fixture';

/**
 * D05 and P02 in the production export over labelled HTTP fixtures: on a desktop every control is a
 * card of one page and an address for a single control goes there; a window that grows past 1024 px
 * under someone who is already on a single control leaves them where they are.
 */
const acknowledge = 'I understand this cannot be undone';

test('a single-control address opened on a desktop goes to the one page with its cards', async ({ page }) => {
  await signedInAccount(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account/privacy/clear');
  await expect(page).toHaveURL(/\/account\/privacy$/);
  await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: acknowledge })).toHaveCount(2);
});

test('growing the window past 1024 px keeps the step the person is on', async ({ page }) => {
  await signedInAccount(page);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/account/privacy/delete');
  const box = page.getByRole('checkbox', { name: acknowledge });
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page).toHaveURL(/\/account\/privacy\/delete$/);
  await expect(box).toHaveAttribute('aria-checked', 'true');
});
