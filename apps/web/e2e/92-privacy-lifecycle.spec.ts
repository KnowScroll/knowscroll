import { expect, test } from './support/fixtures.ts';

/**
 * #119 (ADR-0030): pause, export and reset landed as real HTTP routes (PR #114) but nothing on
 * the web surface reached them. This proves the panel against the real disposable
 * API/worker/PostgreSQL scripts/run-web-reader-journey.ts provisions -- pause, a genuine re-read
 * of `GET /v1/universe`, resume, and export -- never a mock, with every claim the UI makes
 * cross-checked directly against the real backend via `apiFetch`.
 *
 * Numbered "92-" so it runs strictly last, after every other spec file. Reset
 * (`packages/db/src/privacy.ts`) deliberately revokes *every* device session for the universe,
 * including the one bound to this whole run's own `KS_DEV_TOKEN` (`ensureDevelopmentSession` mints
 * that session exactly once, at API process startup, and never re-mints it) -- so exercising Reset
 * here would permanently 401 every request this disposable API process makes for the rest of the
 * run, including Playwright's own teardown. That is ADR-0030 working exactly as designed (a person
 * who resets must sign in again like everyone else); the web app has no sign-in surface yet to
 * recover with (see docs/CHECKPOINT.md "Next work"), so Reset itself is proven only at the unit
 * level (test/unit/readerStore.test.ts, test/unit/PrivacyScreen.test.tsx), never against a shared
 * live server this suite still needs afterward.
 */
test.describe('privacy lifecycle: pause, resume and export (real disposable API, never a mock)', () => {
  test('pauses recording, genuinely re-reads the universe, resumes, and exports the real record', async ({ page, apiFetch }) => {
    const universeRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'GET' && request.url().endsWith('/v1/universe')) universeRequests.push(request.url());
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open privacy controls' })).toBeVisible();
    const beforeOpen = universeRequests.length;

    await page.getByRole('button', { name: 'Open privacy controls' }).click();
    await expect(page.getByRole('heading', { name: 'Recording is on' })).toBeVisible();
    // Opening the panel itself re-fetches nothing -- it reads the Universe already loaded.
    expect(universeRequests.length).toBe(beforeOpen);

    // Independently confirm the server's own starting truth before touching anything.
    const startResponse = await apiFetch('/v1/universe');
    expect(startResponse.status).toBe(200);
    const start = (await startResponse.json()) as { recordingPausedAt: string | null };
    expect(start.recordingPausedAt).toBeNull();

    await page.getByRole('button', { name: 'Pause recording' }).click();
    await expect(page.getByRole('heading', { name: 'Recording is paused' })).toBeVisible({ timeout: 8000 });
    // The client must have genuinely re-read GET /v1/universe after the pause POST -- never merely
    // trusted the POST's own receipt (#119's honesty rule: "re-read after every action").
    await expect.poll(() => universeRequests.length).toBeGreaterThan(beforeOpen);
    const afterPause = universeRequests.length;

    // Cross-checked against the real backend, independent of what the UI claims.
    const pausedResponse = await apiFetch('/v1/universe');
    expect(pausedResponse.status).toBe(200);
    const paused = (await pausedResponse.json()) as { recordingPausedAt: string | null };
    expect(paused.recordingPausedAt).not.toBeNull();

    await page.getByRole('button', { name: 'Resume recording' }).click();
    await expect(page.getByRole('heading', { name: 'Recording is on' })).toBeVisible({ timeout: 8000 });
    await expect.poll(() => universeRequests.length).toBeGreaterThan(afterPause);

    const resumedResponse = await apiFetch('/v1/universe');
    expect(resumedResponse.status).toBe(200);
    const resumed = (await resumedResponse.json()) as { recordingPausedAt: string | null };
    expect(resumed.recordingPausedAt).toBeNull();

    // Export: requests the full real record and offers it as a file the reader chose to save.
    await page.getByRole('button', { name: 'Take your data' }).click();
    const downloadLink = page.getByRole('link', { name: 'Download your export' });
    await expect(downloadLink).toBeVisible({ timeout: 8000 });
    expect(await downloadLink.getAttribute('download')).toBeTruthy();
    const href = await downloadLink.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href!.startsWith('data:application/json')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(href!.slice(href!.indexOf(',') + 1))) as {
      universe: { id: string; recordingPausedAt: string | null };
      rowCounts: Record<string, number>;
    };
    // The exported record must reflect the same real, already-resumed universe -- not a stale or
    // fabricated one.
    expect(decoded.universe.recordingPausedAt).toBeNull();
    const currentSessionResponse = await apiFetch('/v1/session');
    expect(currentSessionResponse.status).toBe(200);
    const currentSession = (await currentSessionResponse.json()) as { universeId: string };
    expect(decoded.universe.id).toBe(currentSession.universeId);

    await page.getByRole('button', { name: 'Return to Universe' }).click();
    await expect(page.getByRole('button', { name: 'Open privacy controls' })).toBeVisible();
  });
});
