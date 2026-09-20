import { expect, test } from './support/fixtures.ts';

test.describe('failure and recovery (real disposable API behind a fault-injecting proxy)', () => {
  test('API unavailable shows a visible retry state that preserves the current page, then recovers', async ({ page, setOutage }) => {
    await page.goto('/');
    // 1 Trace already kept by 01-reader-journey.spec.ts, which runs first in this single-worker suite.
    await expect(page.getByRole('heading', { name: 'Your first little world.' })).toBeVisible();

    await setOutage(true);
    try {
      // A fresh load while the API is unreachable must show the unavailable/retry state, not crash or hang forever.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'The universe is unavailable' })).toBeVisible({ timeout: 8000 });
      await expect(page.getByRole('button', { name: 'Retry loading the universe' })).toBeVisible();
    } finally {
      await setOutage(false);
    }

    await page.getByRole('button', { name: 'Retry loading the universe' }).click();
    await expect(page.getByRole('heading', { name: 'The universe is unavailable' })).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByRole('button', { name: 'Enter Scroll' })).toBeVisible();
  });

  test('a 401 purges scoped storage and shows an honest session-unavailable state', async ({ page, armInvalidateAuth }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    await expect(page.getByRole('article')).toBeVisible();
    await expect(page.evaluate(() => localStorage.getItem('ks_web_v1:session'))).resolves.not.toBeNull();

    await armInvalidateAuth('GET', '/v1/universe');
    await page.getByRole('button', { name: 'Return to Universe' }).click();

    await expect(page.getByRole('heading', { name: 'The universe is unavailable' })).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('This device session is no longer available.')).toBeVisible();

    const remainingSession = await page.evaluate(() => localStorage.getItem('ks_web_v1:session'));
    const remainingRevisit = await page.evaluate(() => localStorage.getItem('ks_web_v1:revisit'));
    expect(remainingSession).toBeNull();
    expect(remainingRevisit).toBeNull();

    await page.getByRole('button', { name: 'Retry loading the universe' }).click();
    await expect(page.getByRole('heading', { name: 'The universe is unavailable' })).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByRole('button', { name: 'Enter Scroll' })).toBeVisible();
  });
});
