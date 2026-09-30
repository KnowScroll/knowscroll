import { expect, test } from './support/fixtures.ts';

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 700 },
  { width: 700, height: 560 },
  { width: 920, height: 740 },
]) {
  test(`Atlas empty state, Keep and revisit at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');

    // Earlier reader journeys have already kept a Trace. The disposable
    // fixture still has no mapped substrate, so Atlas must remain honestly empty.
    await page.getByRole('button', { name: 'Atlas — open your places' }).click();
    const atlas = page.getByRole('main', { name: 'Atlas', exact: true });
    await expect(atlas).toBeVisible();
    await expect(atlas.getByRole('heading', { name: 'Your Atlas.' })).toBeVisible();
    await expect(atlas.getByRole('heading', { name: 'A place forms as you explore.' })).toBeVisible();
    await expect(atlas.getByText('Read a Scroll and return when your Atlas has taken shape.')).toBeVisible();
    await expect(atlas).not.toContainText(/https?:\/\//i);
    await expect(atlas.locator('a')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/ui-audit/atlas-empty-${size.width}x${size.height}.png`, fullPage: true });

    await atlas.getByRole('button', { name: 'Return to Universe' }).click();
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep — your saved Traces' }).click();
    await expect(page.getByRole('main', { name: 'Keep', exact: true })).toBeVisible();
    const trace = page.getByRole('button', { name: /Revisit the saved Trace/ }).first();
    await expect(trace).toBeVisible();
    await trace.click();
    await expect(page.getByText('Saved Trace · revisiting a kept Scroll')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kept' })).toBeDisabled();
    await page.getByRole('button', { name: 'Return to Universe' }).click();
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
  });
}

test('Atlas empty state remains readable with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Atlas — open your places' }).click();
  const atlas = page.getByRole('main', { name: 'Atlas', exact: true });
  await expect(atlas.getByRole('heading', { name: 'A place forms as you explore.' })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
});

test('the deterministic development context placement keeps the Scroll readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?webVariant=context-after');
  await page.getByRole('button', { name: 'Enter Scroll' }).click();
  await expect(page.locator('.scroll-layout--context-after')).toBeVisible();
  await expect(page.getByRole('article', { name: /Reading:/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open context panel' })).toBeVisible();
});
