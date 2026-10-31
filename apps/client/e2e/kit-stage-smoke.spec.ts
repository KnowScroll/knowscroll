import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import circulation from '@knowscroll/scroll-model/fixtures/circulation-stage-ci.json';
import greenhouse from '@knowscroll/scroll-model/fixtures/greenhouse-stage-ci.json';
import nerve from '@knowscroll/scroll-model/fixtures/nerve-stage-ci.json';
import star from '@knowscroll/scroll-model/fixtures/star-stage-ci.json';
import tides from '@knowscroll/scroll-model/fixtures/tides-stage-ci.json';
import transit from '@knowscroll/scroll-model/fixtures/transit-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture } from './encounter-fixture';

/**
 * The drawing kits of D-194 and D-201 in the production export: each kit's stage in the Stage + Spine reader, over the
 * labelled CI fixtures `<kit>-stage-ci` (not product content) and authored HTTP fixtures. It proves what the
 * client does, not the backend: the picture follows the stop, it is named by the description of its state, a
 * state is drawn without a script error, the reduced-motion path cross-fades, and axe finds nothing at phone
 * and desktop widths. With `KS_KIT_SHOTS=<directory>` it also saves a screenshot of each state, to be read
 * beside the kit page of the V3 design.
 */

const KITS = [
  ['tides', tides],
  ['greenhouse', greenhouse],
  ['star', star],
  ['transit', transit],
  ['circulation', circulation],
  ['nerve', nerve],
] as const;
const sizes = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
] as const;

async function open(page: Page, document: ScrollDocumentV2, viewport: { width: number; height: number }) {
  await encounterFixture(page, 'scroll', {
    viewport,
    scrollDocument: document as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

/** The name of the dot of a stop: what the spine calls it. */
function dotName(document: ScrollDocumentV2, index: number): string {
  const stop = document.stops[index];
  if (stop === undefined) throw new Error('no such stop');
  const calls = document.stops.filter((candidate) => candidate.kind !== 'read');
  if (stop.kind === 'read') return `Stop ${String(index + 1)} of ${String(document.stops.length)}`;
  if (stop.kind === 'final_call') return 'Final call';
  return `Call it ${String(calls.indexOf(stop) + 1)} of ${String(calls.length)}`;
}

const stage = (page: Page) => page.getByTestId('stage');

/** What axe finds that is serious or critical, as the other reader checks judge it. */
async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/** Jumps to the stop a state sits on, and waits until the stage shows it. */
async function showState(page: Page, document: ScrollDocumentV2, stopId: string) {
  const index = document.stops.findIndex((stop) => stop.id === stopId);
  // The dot of the stop the reader is on says so, which a tap on it leaves as it is.
  const name = new RegExp(`^${dotName(document, index)}(, you are here)?$`, 'u');
  await page.getByRole('button', { name }).click();
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', stopId);
  // The picture has settled once no move is under way: the motion token's 320 ms, with room to spare.
  await page.waitForTimeout(500);
}

for (const [name, fixture] of KITS) {
  const document = fixture as unknown as ScrollDocumentV2;
  const states = document.stage?.states ?? [];

  for (const [sizeName, viewport] of sizes) {
    test(`${name} at ${sizeName}: the picture follows the stop, is named by its description, and axe finds nothing`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await open(page, document, viewport);
      await expect(stage(page)).toHaveAttribute('data-ks-stage-state', document.stops[0]?.id ?? '');
      for (const [index, entry] of states.entries()) {
        await showState(page, document, entry.stop);
        await expect(page.getByRole('img', { name: entry.alt, exact: true })).toBeVisible();
        const box = await stage(page).boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(300);
        const directory = process.env['KS_KIT_SHOTS'];
        if (directory !== undefined && directory !== '') {
          const label = `${name}-${sizeName}-${String(index + 1)}-${entry.stop}`;
          await page.screenshot({ path: `${directory}/${label}.png` });
          await stage(page).screenshot({ path: `${directory}/${label}-stage.png` });
        }
        if (index === 0 || index === states.length - 1) {
          expect(await audit(page), `${name} state ${entry.stop}`).toEqual([]);
        }
      }
      expect(errors).toEqual([]);
    });
  }

  test(`${name}: the text version replaces the picture with the sentences of the state`, async ({ page }) => {
    await open(page, document, sizes[0][1]);
    const entry = states[1];
    if (entry === undefined) throw new Error('the fixture has several states');
    await showState(page, document, entry.stop);
    await page.getByRole('button', { name: /text version/i }).click();
    await expect(stage(page).getByText(entry.alt, { exact: true })).toBeVisible();
  });

  test(`${name}: under reduced motion a move is a cross-fade, never a glide`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, document, sizes[0][1]);
    const next = states[1];
    if (next === undefined) throw new Error('the fixture has several states');
    await showState(page, document, next.stop);
    await expect(stage(page)).toHaveAttribute('data-ks-stage-transition', 'crossfade');
  });
}
