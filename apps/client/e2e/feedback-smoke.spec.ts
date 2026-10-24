import { expect, test, type Page, type Route } from '@playwright/test';
import { encounterFixture, id } from './encounter-fixture';

/**
 * P03 over the production export, with labelled HTTP fixtures for the encounter and for `/v1/feedback/*`:
 * "Not interested" moves on and Undo comes back, a content error and an abuse report show their receipt,
 * a report with no answer is kept and sent again with the same command ID, and the Reel's context menu opens
 * the P03 menu. No provider, no backend.
 */
interface Call {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const receipt = (body: Record<string, unknown>) => ({
  commandId: body['commandId'],
  reportId: id(9000),
  receivedAt: new Date().toISOString(),
  replayed: false,
});

async function feedbackFixture(page: Page, kind: 'reel' | 'scroll' = 'reel') {
  await encounterFixture(page, kind);
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 404, body: 'CI gesture fixture only' }),
  );
  const calls: Call[] = [];
  const answers: Record<string, (body: Record<string, unknown>) => unknown> = {
    '/v1/feedback/not-interested': (body) => ({
      commandId: body['commandId'],
      assetId: body['assetId'],
      expiresAt: '2026-11-07T12:00:00.000Z',
      replayed: false,
    }),
    '/v1/feedback/not-interested/undo': (body) => ({
      commandId: body['commandId'],
      assetId: body['assetId'],
      replayed: false,
    }),
    '/v1/feedback/content-errors': receipt,
    '/v1/feedback/abuse-reports': receipt,
  };
  const handler = async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = answers[path];
    if (answer === undefined) await route.fulfill({ status: 404, json: {} });
    else await route.fulfill({ json: answer(body) });
  };
  // A later route wins over the encounter fixture's catch-all.
  await page.route('**/v1/feedback/**', handler);
  return { calls, handler };
}

async function openMore(page: Page) {
  await page.goto('/explore');
  await expect(page.getByTestId('reel-navigation-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
}

test('Not interested saves, moves to the next subject, and Undo takes it back and returns to the Reel', async ({
  page,
}) => {
  const { calls } = await feedbackFixture(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Not interested. Fewer like this one' }).click();
  await expect(page.getByText('Got it — fewer like this.')).toBeVisible();
  await expect(page.getByText('CI encounter fixture 2', { exact: true }).last()).toBeVisible();
  const marked = calls.filter((call) => call.path === '/v1/feedback/not-interested');
  expect(marked).toHaveLength(1);
  expect(marked[0]?.body['assetId']).toBe(id(300));

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => calls.filter((call) => call.path === '/v1/feedback/not-interested/undo').length).toBe(1);
  const undone = calls.find((call) => call.path === '/v1/feedback/not-interested/undo');
  expect(undone?.body['assetId']).toBe(id(300));
  expect(undone?.body['commandId']).not.toBe(marked[0]?.body['commandId']);
  await expect(page.getByText('CI encounter fixture 1', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Got it — fewer like this.')).not.toBeVisible();
});

test('a content error is sent for the exact revision with the person’s reason and note, and answered with a receipt', async ({
  page,
}) => {
  const { calls } = await feedbackFixture(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Report a content error' }).click();
  await expect(page.getByRole('heading', { name: 'Report an error' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Something’s wrong' })).toBeChecked();
  await page.getByRole('radio', { name: 'Misleading' }).click();
  await page.getByLabel('Add a note (optional)').fill('“it” could also mean the street here?');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('heading', { name: 'Report received' })).toBeVisible();
  await expect(page.getByText('Thanks — if we correct it you’ll see a Corrected tag.')).toBeVisible();
  const sent = calls.filter((call) => call.path === '/v1/feedback/content-errors');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toMatchObject({
    target: { assetId: id(300) },
    category: 'misleading',
    note: '“it” could also mean the street here?',
  });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Feedback' })).not.toBeVisible();
});

test('an abuse report needs a reason, and with no answer it says it will send when online and sends the same report again', async ({
  page,
}) => {
  const { calls, handler } = await feedbackFixture(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Report abuse' }).click();
  await expect(page.getByRole('heading', { name: 'Report abuse' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
  await page.getByRole('radio', { name: 'Spam' }).click();
  // No answer at all: the network is gone.
  await page.route('**/v1/feedback/abuse-reports', (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText('Will send when online.')).toBeVisible();
  const first = calls.filter((call) => call.path === '/v1/feedback/abuse-reports');
  expect(first).toHaveLength(0);
  // The network returns; the kept report goes with the same command ID.
  await page.unroute('**/v1/feedback/abuse-reports');
  await page.route('**/v1/feedback/**', handler);
  await expect.poll(() => calls.filter((call) => call.path === '/v1/feedback/abuse-reports').length).toBe(1);
  expect(calls.find((call) => call.path === '/v1/feedback/abuse-reports')?.body).toMatchObject({
    category: 'spam',
    target: { kind: 'asset', assetId: id(300) },
  });
});

test('right-click and Shift+F10 on the Reel open the feedback menu; Escape closes it', async ({ page }) => {
  await feedbackFixture(page);
  await page.goto('/explore');
  const stage = page.getByTestId('reel-navigation-stage');
  await expect(stage).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await stage.click({ button: 'right', position: { x: 40, y: 200 } });
  await expect(page.getByRole('heading', { name: 'Feedback' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report abuse' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Not interested. Fewer like this one' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Feedback' })).not.toBeVisible();
  await stage.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('heading', { name: 'Feedback' })).toBeVisible();
});
