import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { anchorIsMoment, momentOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture, id } from './encounter-fixture';
import { openParty, partyWorld } from './thread-party-fixture';

/**
 * Share a moment (V3 G5, D-292, D-293) in the production export over labelled HTTP fixtures (no backend): the ••• sheet of a
 * v2 Scroll offers "This stop, with its picture"; read in a thread it sends the stop into that thread, and read in Explore
 * it asks which thread. The message carries the exact revision and an anchor with a hash of the stop's words, never the
 * words. The Scroll is the labelled v2 fixture `seasons-stage-ci`. Screenshots are written only when `KS_MOMENT_SHOTS`
 * names a folder.
 */
const document = seasons as unknown as ScrollDocumentV2;
const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
] as const;

async function shot(page: Page, name: string) {
  const folder = process.env['KS_MOMENT_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 160)}`),
    }));
}

for (const viewport of viewports) {
  test(`in a thread, Share a moment sends the stop on screen into that thread and the sheet says so, at ${viewport.name}`, async ({
    page,
  }) => {
    const world = partyWorld({ scrolls: true });
    await openParty(page, world, 'asha', viewport);
    await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
    // What the server would answer a snippet: the send is captured, and the same thread's own receipt is returned.
    const sent: Record<string, unknown>[] = [];
    await page.route('**/v1/social/threads/send', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      sent.push(body);
      const reading = world.handler('asha')('/v1/social/threads/read', { readId: id(1) });
      const thread = (reading.json as { thread: unknown }).thread;
      await route.fulfill({
        json: {
          version: 'content-thread.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          commandId: body['commandId'],
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'thread.send',
          thread,
          messageId: id(8000),
          messageSequence: 1,
          sent: { kind: 'snippet', anchor: 'scroll_passage' },
        },
      });
    });
    if (viewport.width < 768) {
      await page.getByTestId('thread-series-button').click();
      const sheet = page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
      await expect(sheet).toBeVisible();
      await page.waitForTimeout(450);
      await sheet.getByRole('button', { name: /^Part 1, CI part 1/ }).click();
      await page.getByRole('button', { name: 'Read', exact: true }).click();
    } else {
      await page
        .getByRole('region', { name: 'Thread' })
        .getByRole('button', { name: /^Part 1, CI part 1/ })
        .click();
      await page.getByRole('button', { name: 'Read this Scroll' }).click();
    }
    await expect(page.getByTestId('stop-scroller')).toBeVisible();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const share = page.getByTestId('more-share-moment');
    await expect(share).toBeEnabled();
    await shot(page, `moment-more-${viewport.name}`);
    await share.click();
    const sheet = page.getByRole('dialog', { name: 'Share a moment' });
    await expect(sheet).toBeVisible();
    const first = document.stops.find((stop) => stop.kind === 'read')!;
    const moment = momentOf(document, first.id)!;
    await expect(sheet.getByTestId('moment-quote')).toContainText(moment.quote.split('\n')[0]!);
    await sheet.getByLabel('Message (optional)').fill('Does this hold?');
    await shot(page, `moment-sheet-${viewport.name}`);
    expect(await seriousViolations(page)).toEqual([]);
    await sheet.getByTestId('moment-share').click();
    await expect(sheet.getByText('Shared.')).toBeVisible();
    await shot(page, `moment-shared-${viewport.name}`);
    expect(sent).toHaveLength(1);
    const body = sent[0]!['body'] as {
      kind: string;
      target: { assetId: string; assetRevision: number };
      anchor: { kind: string; blockId: string; start: number; end: number; quoteHash: string };
      note?: string;
    };
    // The exact revision, an anchor that is exactly one whole read stop, a note, and none of the stop's words.
    expect(body).toMatchObject({ kind: 'snippet', target: { assetRevision: 1 }, note: 'Does this hold?' });
    expect(body.anchor.kind).toBe('scroll_passage');
    expect(anchorIsMoment(momentOf(document, body.anchor.blockId)!, body.anchor)).toBe(true);
    expect(JSON.stringify(sent[0])).not.toContain(moment.quote.slice(0, 20));
  });

  test(`in Explore, Share a moment asks which thread, and a call cannot be shared, at ${viewport.name}`, async ({
    page,
  }) => {
    await encounterFixture(page, 'scroll', {
      viewport,
      scrollDocument: seasons as unknown as Record<string, unknown>,
    });
    await page.route('**/v1/social/threads/inbox', (route) =>
      route.fulfill({
        json: {
          version: 'content-thread.v1',
          readId: (route.request().postDataJSON() as { readId: string }).readId,
          scope: { accountId: id(1), privacyEpoch: 1 },
          status: 'ready',
          limit: 50,
          viewRevision: 1,
          items: [],
        },
      }),
    );
    await page.goto('/explore');
    await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByTestId('more-share-moment').click();
    const sheet = page.getByRole('dialog', { name: 'Share a moment' });
    await expect(sheet.getByTestId('moment-no-threads')).toContainText('You have no threads yet');
    await shot(page, `moment-explore-no-threads-${viewport.name}`);
  });
}
