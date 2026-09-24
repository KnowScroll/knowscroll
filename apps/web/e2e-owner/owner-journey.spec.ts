/**
 * #135 -- the owner identity/privacy journey over the real desktop cookie session (ADR-0034) and
 * account deletion (ADR-0035): a disposable API/PostgreSQL and a Vite dev server in cookie mode
 * (KS_WEB_AUTH=cookie), provisioned by scripts/run-web-owner-journey.ts. Never the reader
 * journey's bearer/dev-proxy stack -- see playwright.owner.config.ts's own doc comment for why
 * this spec lives in its own testDir rather than apps/web/e2e/.
 *
 * The final DB assertions (0 account rows, 1 account_deletion_receipt row, 0 device_session rows)
 * are made by the runner script after this spec exits, not here -- apps/web has no `pg` dependency
 * of its own (by design: it never touches a database directly), and the runner already holds the
 * one admin connection this disposable stack needs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; set by scripts/run-web-owner-journey.ts`);
  return value;
}

const devRoot = requiredEnv('KS_DEV_ROOT');
const ownerEmail = requiredEnv('KS_OWNER_EMAIL');
const ARTIFACTS_DIR = 'artifacts/web-owner-journey';

test.describe.serial('web owner journey (magic link, cookie sign-in, account deletion)', () => {
  test('sign in with a real emailed magic link, read a real Scroll, then delete the account', async ({ page }) => {
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    // 1. No cookie yet: the app shows the signed-out screen, never the reader.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS_DIR}/01-signed-out.png` });

    // 2. Request a sign-in link -- one fixed message, regardless of address (ADR-0026).
    await page.getByLabel(/email/i).fill(ownerEmail);
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();

    // 3. The harness reads the real emailed link from the dev sink -- never typed or guessed.
    const link = (await readFile(`${devRoot}/sign-in/magic-link.txt`, 'utf8')).trim();
    const linkUrl = new URL(link);
    const pageOrigin = new URL(page.url()).origin;
    expect(`${linkUrl.origin}${linkUrl.pathname}`).toBe(`${pageOrigin}/sign-in`);
    expect(linkUrl.search).toBe(''); // the token never travels in a query string
    expect(linkUrl.hash).toMatch(/^#token=/);

    // 4. Open the link: the page strips the fragment immediately (ADR-0034 section 6) -- the
    // token never lingers in the address bar, even before anything is clicked.
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Sign in on this browser' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    expect(page.url()).not.toContain('token=');
    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-sign-in.png` });

    // 5. Only the explicit click consumes the token and mints the cookie session.
    await page.getByRole('button', { name: 'Sign in on this browser' }).click();
    await expect(page.getByRole('button', { name: 'Enter Scroll' })).toBeVisible({ timeout: 8000 });

    // 6. A real Scroll from the feed.
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    const stage = page.getByRole('article');
    await expect(stage).toBeVisible();
    expect((await stage.innerText()).trim().length).toBeGreaterThan(0);

    // 7. Open privacy and delete the account (the CSRF token the sign-in minted authenticates
    // every one of these mutating requests -- pause/resume/export/reset/revoke/delete all need it).
    await page.getByRole('button', { name: 'Return to Universe' }).click();
    await page.getByRole('button', { name: 'Open privacy controls' }).click();
    await page.getByRole('button', { name: 'Delete account' }).click();
    await page.getByLabel(/type delete to confirm/i).fill('delete');
    await page.getByRole('button', { name: 'Delete my account' }).click();

    // 8. Deleted: back to the signed-out screen, this time with the deletion-specific message.
    await expect(page.getByText('Your account and history were deleted.')).toBeVisible({ timeout: 8000 });
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS_DIR}/03-deleted.png` });

    // Content-free: pass/fail and timing only, never an address, token or page content.
    await writeFile(
      `${ARTIFACTS_DIR}/receipt.json`,
      JSON.stringify({ journey: 'web-owner-135', result: 'passed', finishedAt: new Date().toISOString() }, null, 2),
    );
  });
});
