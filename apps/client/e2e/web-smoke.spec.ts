import { expect, test, type Page } from '@playwright/test';

/**
 * The production web export in Chromium: navigation is made of real links, the keyboard works,
 * every route names the page, focus follows V01's order, and the developer gallery is absent.
 */

const destinations = [
  { name: 'Explore', path: '/explore' },
  { name: 'Universe', path: '/universe' },
  { name: 'Talk', path: '/conversations' },
  { name: 'Keep', path: '/saved' },
] as const;

async function open(page: Page, path: string, width = 390, height = 844) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await expect(page.getByRole('main').first()).toBeVisible();
}

/** The accessible name of the focused element (aria-label or its text). */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return '';
    return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
  });
}

/** Tab through the page and list the focus stops, until focus leaves the document or returns. */
async function tabOrder(page: Page, limit = 40): Promise<string[]> {
  const stops: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab');
    const name = await focusedName(page);
    if (name === '' || (stops.length > 0 && name === stops[0])) break;
    stops.push(name);
  }
  return stops;
}

test.describe('links (B1)', () => {
  for (const [width, label] of [
    [390, 'phone tab bar'],
    [834, 'tablet rail'],
    [1440, 'desktop rail'],
  ] as const) {
    test(`every destination in the ${label} is an anchor with its address`, async ({ page }) => {
      await open(page, '/explore', width);
      for (const destination of destinations) {
        const link = page.getByRole('link', { name: destination.name, exact: true });
        await expect(link).toHaveAttribute('href', destination.path);
        await expect(link).toHaveJSProperty('tagName', 'A');
      }
      await expect(page.getByRole('link', { name: 'Explore', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('link', { name: 'Account and settings' })).toHaveAttribute('href', '/account');
    });
  }

  test('Tab reaches a destination and Enter opens it, with a new page title', async ({ page }) => {
    await open(page, '/explore');
    await expect(page).toHaveTitle('Explore · KnowScroll');
    let reached = false;
    for (let index = 0; index < 30 && !reached; index += 1) {
      await page.keyboard.press('Tab');
      reached = (await focusedName(page)) === 'Keep';
    }
    expect(reached).toBe(true);

    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/saved$/);
    await expect(page).toHaveTitle('Keep · KnowScroll');
    await expect(page.getByRole('link', { name: 'Keep', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('a modified click opens the destination in a new tab and leaves this one', async ({ page, context }) => {
    await open(page, '/explore');
    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: 'Talk', exact: true }).click({ modifiers: ['ControlOrMeta'] }),
    ]);
    await opened.waitForLoadState();
    expect(new URL(opened.url()).pathname).toBe('/conversations');
    expect(new URL(page.url()).pathname).toBe('/explore');
  });

  test('the avatar, the empty-state actions and the not-found link are anchors that navigate', async ({ page }) => {
    await open(page, '/saved');
    const cta = page.getByRole('link', { name: 'Go to Explore' });
    await expect(cta).toHaveAttribute('href', '/explore');
    await cta.click();
    await expect(page).toHaveURL(/\/explore$/);

    await open(page, '/conversations');
    await expect(page.getByText('We can’t reach your account. Try again when connected.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Explore' })).toHaveAttribute('href', '/explore');
    await expect(page.getByText('No conversations yet')).toHaveCount(0);

    await open(page, '/universe');
    await expect(page.getByRole('link', { name: 'Go to Explore' })).toHaveAttribute('href', '/explore');

    await page.getByRole('link', { name: 'Account and settings' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('button', { name: 'Back to Universe' })).toBeVisible();

    await open(page, '/nowhere');
    const home = page.getByRole('link', { name: 'Go to Explore' });
    await expect(home).toHaveAttribute('href', '/explore');
    await home.press('Enter');
    await expect(page).toHaveURL(/\/explore$/);
  });
});

test('every route names the page', async ({ page }) => {
  const titles: [string, string][] = [
    ['/explore', 'Explore'],
    ['/universe', 'Universe'],
    ['/conversations', 'Talk'],
    ['/saved', 'Keep'],
    ['/account', 'Account'],
    ['/welcome', 'Welcome'],
    ['/signin', 'Sign in'],
    ['/nowhere', 'Page not found'],
  ];
  for (const [path, title] of titles) {
    await open(page, path);
    await expect(page).toHaveTitle(`${title} · KnowScroll`);
  }
});

test.describe('focus order (V01: top bar → content → navigation)', () => {
  test('tablet: avatar in the top bar, then the content, then the rail', async ({ page }) => {
    await open(page, '/saved', 834, 1112);
    const stops = await tabOrder(page);
    expect(stops).toEqual(['Account and settings', 'Go to Explore', 'Explore', 'Universe', 'Talk', 'Keep']);
  });

  test('desktop: the content, then the rail with the avatar last', async ({ page }) => {
    await open(page, '/saved', 1440, 900);
    const stops = await tabOrder(page);
    expect(stops).toEqual(['Go to Explore', 'Explore', 'Universe', 'Talk', 'Keep', 'Account and settings']);
  });

  test('phone: the content, then the tab bar', async ({ page }) => {
    await open(page, '/saved', 390, 844);
    const stops = await tabOrder(page);
    expect(stops).toEqual(['Account and settings', 'Go to Explore', 'Explore', 'Universe', 'Talk', 'Keep']);
  });
});

test('the developer gallery is not in the production export', async ({ page }) => {
  await open(page, '/gallery');
  await expect(page.getByText("This page isn't here")).toBeVisible();
  await expect(page.getByTestId('ks-component-gallery')).toHaveCount(0);
  await expect(page).toHaveTitle('Page not found · KnowScroll');
});

test('Talk with a signed-out session offers an actual sign-in anchor and no fabricated empty inbox', async ({
  page,
}) => {
  await page.route('**/auth/session', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await open(page, '/conversations');
  await expect(page.getByText('Sign in to talk with your friends.')).toBeVisible();
  const signIn = page.getByRole('link', { name: 'Sign in', exact: true });
  await expect(signIn).toHaveAttribute('href', '/welcome');
  await expect(page.getByRole('button', { name: 'New message' })).toHaveCount(0);
  await expect(page.getByText('No conversations yet')).toHaveCount(0);
  await signIn.click();
  await expect(page).toHaveURL(/\/welcome$/);
});
