import { expect, test, type Request } from '@playwright/test';

/**
 * The sign-in screens (S1.3 #226) in Chromium over the production export, with no API behind it
 * (`serve-export.mjs` answers every path with the app): what the browser alone must get right —
 * links, the labelled email field and its errors, a sign-in link that opens without signing
 * anyone in and leaves no token in the address bar, and an honest "can't reach" when the API is
 * not there. Sign-in against the API is proved by the release tests and by hand (PR evidence).
 */
const fixtureToken = `ksl_${'A'.repeat(43)}`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('the welcome screen offers email and an existing link, as real links', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: 'KnowScroll', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with email' })).toHaveAttribute('href', '/signin');
  await expect(page.getByRole('link', { name: 'I have a sign-in link' })).toHaveAttribute('href', '/redeem');
  await page.getByRole('link', { name: 'Continue with email' }).click();
  await expect(page).toHaveURL(/\/signin$/);
});

test('the email form names its field, refuses a malformed address, and says when it cannot reach the API', async ({
  page,
}) => {
  await page.goto('/signin');
  const field = page.getByRole('textbox', { name: 'Email address' });
  await expect(field).toHaveAttribute('autocomplete', 'email');
  await field.fill('not-an-address');
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Enter an email address like name@example.com.')).toBeVisible();

  await field.fill('someone@example.test');
  await field.press('Enter');
  await expect(page.getByText("Can't reach KnowScroll.")).toBeVisible();
  await expect(page).toHaveURL(/\/signin$/);
});

test('opening a sign-in link consumes nothing: the token leaves the address bar and waits for the tap', async ({
  page,
}) => {
  const redemptions: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/auth/redeem') redemptions.push(request);
  });
  await page.goto(`/redeem#token=${fixtureToken}`);
  await expect(page.getByRole('heading', { name: 'Finish signing in', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Finish signing in · KnowScroll');
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.location.href)).not.toContain(fixtureToken);
  await page.waitForTimeout(500);
  expect(redemptions).toHaveLength(0);

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => redemptions.length).toBe(1);
  const [redemption] = redemptions;
  expect(redemption?.method()).toBe('POST');
  expect(JSON.parse(redemption?.postData() ?? '{}')).toMatchObject({ token: fixtureToken, client: 'web' });
  // No API answers here: the screen says so instead of pretending.
  await expect(page.getByText("Can't reach KnowScroll.")).toBeVisible();
});

test('without a link the redeem page asks for one, and a failed link explains itself', async ({ page }) => {
  await page.goto('/redeem');
  await expect(page.getByRole('heading', { name: 'Use your sign-in link', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Sign-in link' })
    .fill(`https://app.example.test/redeem#token=${fixtureToken}`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();

  await page.goto('/recover?reason=link');
  await expect(page.getByRole('heading', { name: "This link didn't work", level: 1 })).toBeVisible();
  await expect(page.getByText('Nothing about your account changed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use a different email' })).toHaveAttribute('href', '/signin');
});
