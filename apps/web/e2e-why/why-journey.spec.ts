/**
 * #133 -- journey G on the desktop web: "What led here". Against the disposable API/worker/
 * PostgreSQL loaded with the product library and its editorial substrate, served by
 * `composer-semantic-v3`, with the real cookie session (KS_WEB_AUTH=cookie), provisioned by
 * scripts/run-web-why-journey.ts -- never the reader journey's bearer stack (see
 * playwright.why.config.ts).
 *
 * The reader keeps a Scroll and deliberately asks for the next one until an encounter's recorded
 * path names one of those keeps (a deepen or bridge may grow from any earlier keep, not only the
 * latest -- the lesson recorded in docs/journeys/evidence/composer-v3-2026-09-24). The page is then
 * reloaded, which drops the in-memory CSRF token, and the correction is made with the keyboard
 * alone: it must still be accepted only with the page's own token. The database half (the decision
 * is v3's, the cited keep is a recorded Ledger event, exactly one "less like this" row under the
 * key the page sent, nothing shared changed) is checked by the runner after this spec exits:
 * apps/web deliberately has no database access of its own.
 */
import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; set by scripts/run-web-why-journey.ts`);
  return value;
}

const devRoot = requiredEnv('KS_DEV_ROOT');
const ownerEmail = requiredEnv('KS_OWNER_EMAIL');
const ARTIFACTS_DIR = 'artifacts/web-why-journey';
const MAX_KEEPS = 8;
const LESS_CONFIRMATION = 'You will see less of this route for 14 days. Nothing shared changed.';

interface StoredSession {
  decisionId: string;
  item: { assetId: string; title: string };
  exposureEventId: string;
  keepEventId: string;
}

async function stored(page: Page): Promise<StoredSession | null> {
  const raw = await page.evaluate(() => localStorage.getItem('ks_web_v1:session'));
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

/** The Scroll on screen is recorded as exposed (and, with `other`, is a different one). */
async function waitExposed(page: Page, other?: string): Promise<StoredSession> {
  await expect(page.getByRole('article')).toBeVisible();
  await expect
    .poll(async () => {
      const session = await stored(page);
      return session !== null && session.exposureEventId !== '' && session.item.assetId !== other;
    }, { timeout: 20_000 })
    .toBe(true);
  return (await stored(page))!;
}

const panel = (page: Page) => page.getByRole('region', { name: 'Why this appeared' });

/** Opens the panel and waits until it says what was recorded (not "Reading what was recorded…"). */
async function openWhyAndSettle(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Why this appeared' }).click();
  await expect(panel(page).getByRole('heading', { name: 'What led here' })).toBeVisible();
  await expect(panel(page).getByText('Reading what was recorded…')).toHaveCount(0, { timeout: 15_000 });
}

async function recordedPath(page: Page): Promise<string[]> {
  const list = panel(page).getByRole('list', { name: 'Recorded path' });
  if ((await list.count()) === 0) return [];
  return list.getByRole('listitem').allInnerTexts();
}

test.describe.serial('web why journey (#133, journey G)', () => {
  test('the next encounter names the keep that led to it, and "Less like this" corrects that route', async ({ page }) => {
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    // 1. Sign in with the real emailed magic link and the explicit click (as e2e-owner does).
    await page.goto('/');
    await page.getByLabel(/email/i).fill(ownerEmail);
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();
    const link = (await readFile(`${devRoot}/sign-in/magic-link.txt`, 'utf8')).trim();
    await page.goto(link);
    await page.getByRole('button', { name: 'Sign in on this browser' }).click();
    await expect(page.getByRole('button', { name: 'Enter Scroll' })).toBeVisible({ timeout: 10_000 });

    // 2. Keep, deliberately ask for the next one, and read its recorded path -- until it names a keep.
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    let current = await waitExposed(page);
    const kept: { title: string; eventId: string }[] = [];
    const seen: string[] = [];
    let cited: { title: string; eventId: string } | undefined;
    while (!cited && kept.length < MAX_KEEPS) {
      await page.getByRole('button', { name: 'Keep this Scroll' }).click();
      await expect(page.getByRole('button', { name: 'Kept' })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await stored(page))?.keepEventId ?? '').not.toBe('');
      const keptSession = (await stored(page))!;
      kept.push({ title: keptSession.item.title, eventId: keptSession.keepEventId });

      await page.getByRole('button', { name: 'Next discovery' }).click();
      current = await waitExposed(page, keptSession.item.assetId);

      await openWhyAndSettle(page);
      const path = await recordedPath(page);
      cited = kept.find(k => path.includes(`You kept “${k.title}”`));
      seen.push(`${current.item.title}: ${path.length ? path.join(' / ') : (await panel(page).innerText()).replace(/\s+/g, ' ')}`);
      if (!cited) {
        await page.keyboard.press('Escape');
        await expect(panel(page)).toHaveCount(0);
      }
    }
    expect(cited, `no encounter's recorded path named a keep that led to it:\n${seen.join('\n')}`).toBeDefined();
    // textContent, not innerText: the literal as recorded, not as CSS draws it (uppercase).
    const family = ((await panel(page).locator('.why-family-code').textContent()) ?? '').trim();
    // The rail scrolls: bring the whole "What led here" card to its top, so the evidence shows the
    // path and its corrections together.
    await panel(page).getByRole('region', { name: 'What led here' }).evaluate(card => card.scrollIntoView({ block: 'start' }));
    await expect(panel(page).getByRole('button', { name: 'Less like this' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `${ARTIFACTS_DIR}/why-path.png` });

    // The open panel, with a real recorded path and its corrections, has no serious a11y violation.
    const axe = await new AxeBuilder({ page }).include('main').analyze();
    const serious = axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);

    // 3. Reload: the page restores this same encounter, and its CSRF token (memory only) is gone.
    await page.reload();
    await expect(page.getByRole('article')).toBeVisible();
    expect((await stored(page))?.decisionId).toBe(current.decisionId);

    const attempts: { status: number; carriedCsrfToken: boolean; clientFeedbackId: string }[] = [];
    page.on('response', async response => {
      const request = response.request();
      if (request.method() !== 'POST' || !request.url().endsWith('/v1/encounters/feedback')) return;
      const body = JSON.parse(request.postData() ?? '{}') as { clientFeedbackId?: string };
      attempts.push({ status: response.status(), carriedCsrfToken: Boolean(request.headers()['x-csrf-token']), clientFeedbackId: body.clientFeedbackId ?? '' });
    });

    // 4. Keyboard only: open the panel (focus moves into it), Tab to the first correction, press it.
    const trigger = page.getByRole('button', { name: 'Why this appeared' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeFocused();
    await expect(panel(page).getByText('Reading what was recorded…')).toHaveCount(0, { timeout: 15_000 });
    expect(await recordedPath(page)).toContain(`You kept “${cited!.title}”`);
    await page.keyboard.press('Tab');
    const less = panel(page).getByRole('button', { name: 'Less like this' });
    await expect(less).toBeFocused();
    await page.keyboard.press('Enter');

    // 5. Confirmed in words; not offered again; focus lands on the confirmation, not on <body>.
    const confirmation = panel(page).getByRole('status');
    await expect(confirmation).toHaveText(LESS_CONFIRMATION, { timeout: 15_000 });
    await expect(less).toHaveCount(0);
    await expect(confirmation).toBeFocused();
    await page.screenshot({ path: `${ARTIFACTS_DIR}/why-corrected.png` });

    // Accepted exactly once, only with the page's own token; every attempt was the same intent.
    await expect.poll(() => attempts.filter(a => a.status === 201).length).toBe(1);
    const accepted = attempts.find(a => a.status === 201)!;
    expect(accepted.carriedCsrfToken).toBe(true);
    expect(new Set(attempts.map(a => a.clientFeedbackId)).size).toBe(1);
    expect(attempts.every(a => a.status === 201 || (a.status === 403 && !a.carriedCsrfToken))).toBe(true);

    // 6. The API itself now says this encounter was corrected (read back through the same session).
    const why = await page.evaluate(
      async ([decisionId, assetId]) => (await fetch(`/v1/decisions/${decisionId}/why?assetId=${assetId}`)).json(),
      [current.decisionId, current.item.assetId] as const,
    );
    expect(why.corrected).toEqual(['less_like_this']);

    // 7. Escape closes the panel and hands focus back to its trigger.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await writeFile(
      `${ARTIFACTS_DIR}/receipt.json`,
      JSON.stringify(
        {
          journey: 'web-why-133',
          result: 'passed',
          decisionId: current.decisionId,
          assetId: current.item.assetId,
          title: current.item.title,
          family,
          citedKeepTitle: cited!.title,
          citedKeepEventIds: kept.map(k => k.eventId),
          keepsBeforeCited: kept.length,
          clientFeedbackId: accepted.clientFeedbackId,
          feedbackAttempts: attempts.map(({ status, carriedCsrfToken }) => ({ status, carriedCsrfToken })),
          correctedAfter: why.corrected,
          axeSeriousOrCritical: serious.length,
          seen,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  });
});
