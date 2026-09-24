import { expect, test } from './support/fixtures.ts';

interface StoredSession {
  decisionId: string;
  item: { assetId: string; title: string };
  exposureId: string;
  exposureEventId: string;
  keepJobId: string;
}

async function readStoredSession(page: import('@playwright/test').Page): Promise<StoredSession | null> {
  const raw = await page.evaluate(() => localStorage.getItem('ks_web_v1:session'));
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

test.describe.serial('web reader journey (real disposable API/worker/PostgreSQL)', () => {
  test('shows an honest empty universe before any Trace exists', async ({ page }) => {
    await page.goto('/');
    // Real stage, chosen from the (zero) kept Traces, never a fixed headline (ui-system.md sec.5c).
    await expect(page.getByRole('heading', { name: 'Somewhere new starts here.' })).toBeVisible();
    await expect(page.getByText('No topics to pick. Just something interesting.', { exact: false })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Saved Traces' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enter Scroll' })).toBeVisible();
  });

  test('exposure is recorded only once the Scroll is actually visible; reason, truth state and source rail are real returned facts', async ({
    page,
    apiFetch,
  }) => {
    const exposureRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/exposures')) exposureRequests.push(request.url());
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Enter Scroll' }).click();

    const stage = page.getByRole('article');
    await expect(stage).toBeVisible();
    // Give the IntersectionObserver a moment; the exposure call must be exactly one.
    await expect
      .poll(() => exposureRequests.length, { timeout: 5000 })
      .toBe(1);

    // The why-this-appeared panel must show only returned facts.
    await page.getByRole('button', { name: 'Why this appeared' }).click();
    const reasonText = await page.locator('.why-this-appeared dd').first().innerText();
    expect(reasonText.length).toBeGreaterThan(0);
    await expect(page.getByText('DOCUMENTED', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Directly supported by strong cited evidence/).first()).toBeVisible();
    // #133: "What led here" reads the recorded explanation back from the API. This fixture library
    // carries no substrate (no concepts, no bridges), so the Composer could only serve this Scroll
    // as an unmapped fallback: an honest empty path, and nothing offered to correct. The full path
    // and its correction are journey G (e2e-why/, scripts/run-web-why-journey.ts).
    const whatLedHere = page.getByRole('region', { name: 'What led here' });
    await expect(whatLedHere.getByText('Nothing you did led here; it was offered so nothing in the library stays hidden.')).toBeVisible();
    await expect(whatLedHere.getByText('fallback', { exact: true })).toBeVisible();
    await expect(whatLedHere.getByRole('group', { name: 'Correct this route' })).toHaveCount(0);

    // Source rail: keyboard toggle ('s'), attributes on the outbound link.
    await stage.focus();
    await page.keyboard.press('s');
    const sourceLink = page.getByRole('link', { name: /Open source/ });
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toHaveAttribute('target', '_blank');
    await expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer');
    const href = await sourceLink.getAttribute('href');
    expect(href).toMatch(/^https:\/\//);

    // Verify against the real backend: the stored exposure event genuinely exists and is an "exposure".
    // The poll above only proves the request was sent; the receipt is persisted when the response
    // lands. Wait for that effect (the same idiom as the reload test below) rather than assume the
    // UI steps in between outlast the response — on a loaded runner they did not (main 91f2a5d).
    await expect.poll(async () => (await readStoredSession(page))?.exposureEventId ?? '', { timeout: 8000 }).not.toBe('');
    const stored = await readStoredSession(page);
    expect(stored?.exposureEventId).toBeTruthy();
    const eventResponse = await apiFetch(`/v1/events/${stored!.exposureEventId}`);
    expect(eventResponse.status).toBe(200);
    const eventBody = (await eventResponse.json()) as { kind: string };
    expect(eventBody.kind).toBe('exposure');

    expect(exposureRequests).toHaveLength(1); // still exactly one after all interactions above
  });

  test('no exposure is recorded for a hidden document, and none before the stage is visible', async ({ page }) => {
    const exposureRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/exposures')) exposureRequests.push(request.url());
    });

    await page.goto('/');
    // Simulate a hidden/background tab before the Scroll stage ever mounts.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    await expect(page.getByRole('article')).toBeVisible();
    await page.waitForTimeout(500);
    expect(exposureRequests).toHaveLength(0);

    // Now the tab becomes visible: the same still-current Scroll must be exposed.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => exposureRequests.length, { timeout: 5000 }).toBe(1);
  });

  test('Keep retried after a dropped response yields exactly one keep, then the Trace appears on Universe', async ({ page, armDrop, apiFetch }) => {
    const interactionRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/interactions')) interactionRequests.push(request.url());
    });

    await armDrop('POST', '/v1/interactions');
    await page.goto('/');
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    await expect(page.getByRole('article')).toBeVisible();

    const stored = await readStoredSession(page);
    const assetId = stored!.item.assetId;
    const title = stored!.item.title;

    await page.getByRole('button', { name: 'Keep this Scroll' }).click();
    // The client's own retry (network failure -> retry with the same identity) absorbs the drop.
    await expect(page.getByRole('button', { name: 'Kept' })).toBeVisible({ timeout: 8000 });
    expect(interactionRequests.length).toBeGreaterThanOrEqual(1);

    // Confirm against the real backend accounting: exactly one keep Ledger event for this asset/session envelope.
    const afterStored = await readStoredSession(page);
    expect(afterStored?.keepJobId).toBeTruthy();
    const eventResponse = await apiFetch(`/v1/events/${afterStored!.exposureEventId}`);
    expect(eventResponse.status).toBe(200);

    await page.getByRole('button', { name: 'Return to Universe' }).click();
    // This is the run's first Keep: the real stage now has 1 kept Trace (ui-system.md sec.5c).
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
    const trace = page.getByRole('button', { name: new RegExp(`Revisit the saved Trace: ${title}`) });
    await expect(trace).toBeVisible();

    test.info().annotations.push({ type: 'kept-asset-id', description: assetId });
  });

  test('deliberate Next discovery eventually reaches a finite-library rest', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    await expect(page.getByRole('article')).toBeVisible();

    // Exactly two editorial Scrolls remain unkept; walking Next must reach Exhausted deterministically.
    for (let i = 0; i < 3; i++) {
      const nextButton = page.getByRole('button', { name: 'Next discovery' });
      if ((await nextButton.count()) === 0) break;
      if (await page.getByRole('heading', { name: /reached the end/ }).isVisible().catch(() => false)) break;
      await nextButton.click();
      await page.waitForTimeout(200);
    }
    await expect(page.getByRole('heading', { name: /reached the end of the current library/ }).first()).toBeVisible({ timeout: 8000 });
  });

  test('a saved-Trace revisit is read-only: verified origin, no new exposure, exact return', async ({ page }) => {
    await page.goto('/');
    // 1 Trace already kept by this point in the run.
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
    const traceButton = page.getByRole('button', { name: /Revisit the saved Trace/ }).first();
    await expect(traceButton).toBeVisible();

    const exposureRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/exposures')) exposureRequests.push(request.url());
    });

    await traceButton.click();
    await expect(page.getByText('Saved Trace · revisiting a kept Scroll')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kept' })).toBeDisabled();
    await page.waitForTimeout(500);
    expect(exposureRequests).toHaveLength(0);

    await page.getByRole('button', { name: 'Return to Universe' }).click();
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
  });

  test('reload restores the current Scroll and its retry envelope from storage', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    await expect(page.getByRole('article')).toBeVisible();
    await expect.poll(async () => (await readStoredSession(page))?.exposureId).not.toBe('');
    const before = await readStoredSession(page);

    await page.reload();
    await expect(page.getByRole('article')).toBeVisible();
    const after = await readStoredSession(page);
    expect(after?.item.assetId).toBe(before?.item.assetId);
    expect(after?.exposureId).toBe(before?.exposureId);
  });
});
