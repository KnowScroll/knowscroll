import { expect, test, type Page } from '@playwright/test';

/**
 * The interactive and visual Scroll blocks in a real browser (the gallery export, `/gallery-scroll`
 * with the experiments document): the slider by keyboard, pointer and tap, with the touch-action
 * that keeps vertical panning; the token drag, its list of targets and Reset; the stepper; the
 * chart's table; the text version of the whole article; no console errors anywhere.
 */

interface GalleryEvents {
  interactions: { blockId: string; kind: string }[];
  diagnostics: { blockId: string; blockType: string; reason: string }[];
}

async function events(page: Page): Promise<GalleryEvents> {
  return page.evaluate(() => (window as unknown as { __ksScrollGallery: GalleryEvents }).__ksScrollGallery);
}

const problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${String(error)}`));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/gallery-scroll?doc=experiments');
  await expect(page.getByTestId('ks-scroll-gallery')).toBeVisible();
});

test.afterEach(() => {
  expect(problems).toEqual([]);
});

test('the slider is a real slider: a name, a range, the value in words, and keys that step, page and jump', async ({
  page,
}) => {
  const slider = page.getByRole('slider', { name: 'String length' });
  await slider.scrollIntoViewIfNeeded();
  await expect(slider).toHaveAttribute('aria-valuemin', '0.25');
  await expect(slider).toHaveAttribute('aria-valuemax', '4');
  await expect(slider).toHaveAttribute('aria-valuetext', '1.00 m');

  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '1.25 m');
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', '4.00 m');
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', '0.25 m');
  await page.keyboard.press('PageUp');
  await expect(slider).toHaveAttribute('aria-valuetext', '0.75 m');
  await expect(page.getByText(/swings once in about/)).toHaveText('A 0.75 m string swings once in about 1.7 s.');
});

test('a drag moves the slider live, keeps the value on release and reports one drag; a tap jumps; touch-action keeps vertical panning', async ({
  page,
}) => {
  const slider = page.getByRole('slider', { name: 'String length' });
  await slider.scrollIntoViewIfNeeded();
  await expect(slider).toHaveCSS('touch-action', 'pan-y');
  const box = await slider.boundingBox();
  if (box === null) throw new Error('the slider is on the page');
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, y + 2, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 });
  await expect(slider).toHaveAttribute('aria-valuetext', '3.25 m');
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuetext', '3.25 m');

  await page.mouse.click(box.x + box.width * 0.25, y);
  await expect(slider).toHaveAttribute('aria-valuetext', '1.00 m');
  const kinds = (await events(page)).interactions
    .filter((entry) => entry.blockId === 'sim-pendulum')
    .map((entry) => entry.kind);
  expect(kinds).toEqual(['drag', 'control']);
});

test('the notice is always there, and Reset puts the slider back', async ({ page }) => {
  const block = page.locator('#block-sim-pendulum');
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByText('Illustrative', { exact: true })).toBeVisible();
  const reset = block.getByRole('button', { name: 'Reset' });
  await expect(reset).toBeDisabled();

  await block.getByRole('slider').focus();
  await page.keyboard.press('End');
  await expect(reset).toBeEnabled();
  await reset.click();

  await expect(block.getByRole('slider')).toHaveAttribute('aria-valuetext', '1.00 m');
});

test('a typed number is read, snapped onto its grid and kept; a personal value says where it stays', async ({
  page,
}) => {
  const field = page.getByLabel('Your altitude', { exact: true });
  await field.scrollIntoViewIfNeeded();
  await expect(field).toHaveValue('0 m');
  await expect(page.getByText('Stays on this device unless you choose to include it when you share.')).toBeVisible();

  await field.fill('2,100');
  await field.blur();

  await expect(field).toHaveValue('2,000 m');
  await expect(page.getByText('93.4 °C')).toBeVisible();
});

test('the token drags onto a target and chooses its frame; anywhere else changes nothing; the buttons offer the same choice', async ({
  page,
}) => {
  const block = page.locator('#block-diagram-weight');
  const token = page.getByTestId('diagram-token-load');
  await token.scrollIntoViewIfNeeded();
  const status = block.getByRole('status');
  await expect(status).toContainText('With the weight over the middle');
  await expect(token).toHaveCSS('touch-action', 'none');

  const canvas = await block.locator('[role=img]').first().boundingBox();
  const start = await token.boundingBox();
  if (canvas === null || start === null) throw new Error('the diagram is on the page');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.18, { steps: 8 });
  await page.mouse.up();
  await expect(status).toContainText('With the weight over the left pier');

  const again = await token.boundingBox();
  if (again === null) throw new Error('the token is on the page');
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 10, canvas.y + canvas.height - 10, { steps: 6 });
  await page.mouse.up();
  await expect(status).toContainText('With the weight over the left pier');

  await block.getByRole('button', { name: 'Toward Right pier' }).click();
  await expect(status).toContainText('With the weight over the right pier');
  await block.getByRole('button', { name: 'Reset' }).click();
  await expect(status).toContainText('With the weight over the middle');
  const kinds = (await events(page)).interactions
    .filter((entry) => entry.blockId === 'diagram-weight')
    .map((entry) => entry.kind);
  expect(kinds).toEqual(['drag', 'control', 'control']);
});

test('the stepper steps, the chart gives its table, and Describe gives a diagram in words', async ({ page }) => {
  const stepper = page.locator('#block-seq-size');
  await stepper.scrollIntoViewIfNeeded();
  await expect(stepper.getByText('Step 1 of 4')).toBeVisible();
  await stepper.getByRole('button', { name: 'Next' }).click();
  await expect(stepper.getByText('Step 2 of 4')).toBeVisible();
  await expect(stepper.getByText('Choose the shape')).toBeVisible();

  const chart = page.locator('#block-chart-line');
  await chart.scrollIntoViewIfNeeded();
  await chart.getByRole('button', { name: 'Show data as a table' }).click();
  await expect(chart.getByRole('table')).toBeVisible();
  await expect(chart.getByRole('columnheader', { name: 'Weight (kN)' })).toBeVisible();

  const layers = page.locator('#block-diagram-layers');
  await layers.scrollIntoViewIfNeeded();
  await layers.getByRole('button', { name: 'Describe this diagram' }).click();
  await expect(layers.getByText('Foundation → Soil')).toBeVisible();
});

test('the text version of the article swaps every slider for a stepper and every picture for its words', async ({
  page,
}) => {
  await page.getByRole('switch', { name: 'Text version of diagrams' }).click();

  await expect(page.getByRole('slider')).toHaveCount(0);
  const block = page.locator('#block-sim-pendulum');
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByText('Swing time: 2.0 s')).toBeVisible();
  await block.getByRole('button', { name: 'More String length' }).click();
  await expect(block.getByText('Swing time: 2.2 s')).toBeVisible();
  await expect(page.locator('#block-chart-line').getByRole('table')).toBeVisible();
});

test('a three-column comparison stacks on a phone: its columns sit one under another', async ({ page }) => {
  const comparison = page.locator('#block-cmp-three');
  await comparison.scrollIntoViewIfNeeded();
  const columns = await comparison
    .getByRole('group')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
  expect(new Set(columns.map(Math.round)).size).toBe(columns.length);
});
