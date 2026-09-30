import { expect, test } from './support/fixtures.ts';

interface Session { item: { assetId: string; title: string }; exposureId: string; exposureEventId: string }
interface Branch { branchId: string; target: { title: string; assetId: string } }

async function session(page: import('@playwright/test').Page): Promise<Session | null> {
  return page.evaluate(() => {
    const value = localStorage.getItem('ks_web_v1:session');
    return value ? JSON.parse(value) as Session : null;
  });
}

test('a real source-backed horizontal continuation records an exact target, exposes it when visible, and returns', async ({ page, apiFetch }) => {
  test.skip(process.env.KS_WEB_JOURNEY_MODE !== 'branch', 'requires the source-backed editorial substrate');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter Scroll' }).click();

  let offered: Branch[] = [];
  let origin: Session | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    await expect.poll(async () => (await session(page))?.exposureEventId ?? '').not.toBe('');
    origin = await session(page);
    const response = await apiFetch(`/v1/assets/${origin!.item.assetId}/branches?webReader=v1`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { branches: Branch[] };
    expect(JSON.stringify(payload)).not.toMatch(/sourceTitle|sourceUrl|publisher|licen[cs]e/i);
    offered = payload.branches;
    if (offered.length) break;
    const previousAssetId = origin!.item.assetId;
    await page.getByRole('button', { name: 'Next discovery' }).click();
    await expect.poll(async () => (await session(page))?.item.assetId ?? '').not.toBe(previousAssetId);
  }
  expect(offered.length, 'the editorial substrate offers a live continuation').toBeGreaterThan(0);
  expect(origin?.exposureId).toBeTruthy();

  await page.getByRole('button', { name: 'Explore connections' }).click();
  const panel = page.getByRole('region', { name: 'Connections' });
  await expect(panel.getByRole('button', { name: /Follow connection/ }).first()).toBeEnabled();
  await expect(panel).not.toContainText(/https?:\/\//i);
  const branchResponse = page.waitForResponse(response => response.url().includes('/v1/branches?webReader=v1') && response.request().method() === 'POST');

  // This synthetic pointer checks the browser wiring and settle/cancel state;
  // physical iPhone touch and Safari back-edge ownership remain device work.
  await page.locator('.encounter-gesture__surface').evaluate(surface => {
    const event = (type: string, x: number) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType: 'pen', clientX: x, clientY: 450,
      // Event.timeStamp is browser owned. The travel distance alone commits.
    }));
    event('pointerdown', 300);
    event('pointermove', 160);
    event('pointerup', 100);
  });
  const posted = await branchResponse;
  expect(posted.status()).toBe(201);
  const receipt = await posted.json() as { decisionId: string | null; items: Array<{ assetId: string }>; branch: { recorded: boolean } };
  expect(receipt.branch.recorded).toBe(true);
  expect(receipt.decisionId).toBeTruthy();
  expect(receipt.items).toHaveLength(1);
  expect(receipt.items[0]?.assetId).toBe(offered[0]?.target.assetId);
  expect(JSON.stringify(receipt)).not.toMatch(/sourceTitle|sourceUrl|publisher|licen[cs]e/i);
  await expect(page.getByRole('heading', { name: offered[0]!.target.title })).toBeVisible();
  await expect.poll(async () => (await session(page))?.exposureEventId ?? '').not.toBe('');
  await page.screenshot({ path: 'artifacts/ui-audit/branch-target-390x844.png', fullPage: true });
  await page.getByRole('button', { name: 'Return to origin' }).first().click();
  await expect(page.getByRole('heading', { name: origin!.item.title })).toBeVisible();
  await page.screenshot({ path: 'artifacts/ui-audit/branch-return-390x844.png', fullPage: true });
});
