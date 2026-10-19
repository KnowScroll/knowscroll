import { expect, test, type Request } from '@playwright/test';

/**
 * The sign-in screens (S1.3 #226) in Chromium over the production export, with no API behind it
 * (`serve-export.mjs` answers every path with the app): what the browser alone must get right —
 * links, the labelled email field and its errors, a sign-in link that opens without signing
 * anyone in, leaves no token in the address bar and names the account before the tap (the API's
 * peek answer is a route fixture), and an honest "can't reach" when the API is not there. Sign-in against the API is proved by the release tests and by hand (PR evidence).
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

test('opening a sign-in link consumes nothing: the token leaves the address bar, the page names the account and waits for the tap', async ({
  page,
}) => {
  const peeks: Request[] = [];
  const redemptions: Request[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/auth/peek') peeks.push(request);
    if (path === '/auth/redeem') redemptions.push(request);
  });
  // The API's answer to the peek (review m8): whose account the link opens, masked.
  await page.route('**/auth/peek', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ maskedEmail: 'm•••@example.test' }),
    }),
  );
  await page.goto(`/redeem#token=${fixtureToken}`);
  await expect(page.getByRole('heading', { name: 'Finish signing in', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Finish signing in · KnowScroll');
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.location.href)).not.toContain(fixtureToken);
  await expect(
    page.getByText("This link signs you in as m•••@example.test. Continue only if that's your email."),
  ).toBeVisible();
  expect(peeks).toHaveLength(1);
  expect(JSON.parse(peeks[0]?.postData() ?? '{}')).toEqual({ token: fixtureToken, client: 'web' });
  await page.waitForTimeout(500);
  expect(redemptions).toHaveLength(0);

  await page.getByRole('button', { name: 'Continue as m•••@example.test' }).click();
  await expect.poll(() => redemptions.length).toBe(1);
  const [redemption] = redemptions;
  expect(redemption?.method()).toBe('POST');
  expect(JSON.parse(redemption?.postData() ?? '{}')).toMatchObject({ token: fixtureToken, client: 'web' });
  // No API answers here: the screen says so instead of pretending.
  await expect(page.getByText("Can't reach KnowScroll.")).toBeVisible();
});

test('without a link the redeem page asks for one, checks a pasted one first, and a failed link explains itself', async ({
  page,
}) => {
  await page.goto('/redeem');
  await expect(page.getByRole('heading', { name: 'Use your sign-in link', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Sign-in link' })
    .fill(`https://app.example.test/redeem#token=${fixtureToken}`);
  // No API behind this server: the check fails as offline, and the page offers to try again.
  await expect(page.getByText("Can't reach KnowScroll.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();

  await page.goto('/recover?reason=link');
  await expect(page.getByRole('heading', { name: "This link didn't work", level: 1 })).toBeVisible();
  await expect(page.getByText('Nothing about your account changed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use a different email' })).toHaveAttribute('href', '/signin');
});

test('a link the API refuses goes straight to "This link didn\'t work", without redeeming it', async ({ page }) => {
  const redemptions: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/auth/redeem') redemptions.push(request);
  });
  await page.route('**/auth/peek', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'tag:knowscroll.space,2026:problem:sign-in-link-invalid',
        title: 'This sign-in link has expired or was already used.',
        status: 400,
        code: 'SIGN_IN_LINK_INVALID',
      }),
    }),
  );
  await page.goto(`/redeem#token=${fixtureToken}`);
  await expect(page.getByRole('heading', { name: "This link didn't work", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/recover\?reason=link$/);
  expect(redemptions).toHaveLength(0);
});
