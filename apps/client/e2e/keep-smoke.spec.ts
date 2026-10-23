import { expect, test, type Page } from '@playwright/test';
import sourceDocument from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { parseDocument, computeIntegrity } from '@knowscroll/scroll-model';

/** Production-export consumer over authored HTTP fixtures. No live backend or decoded Reel proof. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
async function keptUI(page: Page, kind: 'reel' | 'scroll') {
  const parsed = parseDocument({ ...sourceDocument, assetId: id(3) });
  if (parsed.kind !== 'valid') throw new Error('Canonical authored fixture');
  const document = {
    ...parsed.document,
    integrity: { ...parsed.document.integrity, sha256: computeIntegrity(parsed.document) },
  };
  expect(parseDocument(document, { verify: true }).kind).toBe('valid');
  const assetId = id(3);
  const revision = kind === 'scroll' ? document.revision : 1;
  let membership = id(4);
  let placeRevision = 1;
  let position: unknown =
    kind === 'scroll'
      ? { kind, blockId: document.sections[0]!.blocks[0]!.id, offsetWithinBlock: 37.5 }
      : { kind, positionMs: 12345.5 };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const metadata = { kind, title: `Kept ${kind} CI fixture`, summary: 'Authored HTTP fixture only', language: 'en' };
  const scope = { accountId: id(1), privacyEpoch: 1 };
  const entry = () => ({ assetId, assetRevision: revision, savedEntryId: membership });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      json: {
        account: { ...scope, universeId: id(2), email: 'keep@fixture.test' },
        client: 'web',
        expiresAt: '2099-10-22T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.method() === 'POST' ? (req.postDataJSON() as Record<string, unknown>) : {};
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          version: 'recording-policy.v1',
          ...body,
          scope,
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    calls.push({ path, body });
    if (path === '/v1/saved')
      return route.fulfill({
        json: {
          pagination: 'saved-page.v1',
          consistency: 'live',
          scope,
          filter: new URL(req.url()).searchParams.get('filter'),
          limit: 20,
          ...(new URL(req.url()).searchParams.has('cursor')
            ? { requestCursor: new URL(req.url()).searchParams.get('cursor') }
            : {}),
          continuation: { status: 'end' },
          revision: 1,
          items: [
            {
              assetId,
              assetRevision: revision,
              savedEntryId: membership,
              kind,
              savedAt: '2026-10-22T00:00:00.000Z',
              metadata,
              availability: 'available',
            },
          ],
        },
      });
    if (path.endsWith('/keep/read'))
      return route.fulfill({
        json: {
          version: 'keep-place.v1',
          scope,
          target: { assetId, assetRevision: revision },
          status: 'available',
          entry: entry(),
          place:
            placeRevision === 0 ? { status: 'none', placeRevision: 0 } : { status: 'set', placeRevision, position },
        },
      });
    if (path.endsWith('/keep/place')) {
      position = body.position;
      placeRevision++;
      return route.fulfill({
        json: {
          version: 'keep-place.v1',
          scope,
          commandId: body.commandId,
          recordedAt: '2026-10-22T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.place.set',
          entry: body.entry,
          basePlaceRevision: body.expectedPlaceRevision,
          acceptedPlaceRevision: placeRevision,
        },
      });
    }
    if (path.endsWith('/experience/open'))
      return route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(5),
          intentRevision: 1,
          revision: 1,
          decisionId: id(6),
          replayed: false,
          status: 'ready',
          offer: {
            offerId: id(7),
            decisionId: id(6),
            assetId,
            assetRevision: revision,
            explanationUnitId: 'kept-ci-fixture',
            metadata,
            relation: { kind: 'return' },
            variants: [],
          },
          bufferedOffers: [],
        },
      });
    if (path.endsWith('/experience/activate'))
      return route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(5),
          intentRevision: 1,
          offerId: id(7),
          exposureId: id(8),
          assetId,
          assetRevision: revision,
          kind,
          activatedAt: '2026-10-22T00:00:00.000Z',
          revision: 1,
          replayed: false,
        },
      });
    if (path.endsWith('/context'))
      return route.fulfill({
        json: {
          exposureId: id(8),
          assetId,
          assetRevision: revision,
          revision: 1,
          session: { sessionId: id(5), intentRevision: 1 },
          actions: { saved: true, liked: false, hidden: false },
          variants: [],
          continuations: {
            seriesNext: { status: 'unavailable', reason: 'series_boundary' },
            seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
            related: { status: 'unavailable', reason: 'no_related_ready' },
          },
        },
      });
    if (path.endsWith('/document'))
      return route.fulfill({
        json: { exposureId: id(8), assetId, assetRevision: revision, document, degradedEssential: [] },
      });
    if (path === '/v1/media/grants')
      return route.fulfill({
        json: {
          document: {
            schemaVersion: 'reel-document.v1',
            assetId,
            revision,
            title: metadata.title,
            summary: metadata.summary,
            language: metadata.language,
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
            durationMs: 20000,
            width: 1080,
            height: 1920,
          },
          path: '/media/keep-ci-fixture',
          expiresAt: '2099-10-22T00:00:00.000Z',
        },
      });
    if (path === '/v1/observations/recording-batch')
      return route.fulfill({
        json: {
          version: 'observation-batch.v2',
          recordingGeneration: body.recordingGeneration,
          currentGeneration: 1,
          scope,
          result: 'processed',
          accepted: (body.events as { eventId: string }[]).length,
          duplicates: 0,
          rejected: 0,
          revision: 1,
          results: (body.events as { eventId: string }[]).map((event) => ({
            eventId: event.eventId,
            status: 'accepted',
          })),
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('**/media/keep-ci-fixture', (route) =>
    route.fulfill({ status: 404, body: 'Fixture has no decoded media' }),
  );
  return {
    calls,
    replace: () => {
      membership = id(9);
      placeRevision = 0;
      position = { kind: 'reel', positionMs: 0 };
    },
  };
}
for (const kind of ['scroll', 'reel'] as const) {
  test(`Keep ${kind} detail uses server membership; explicit restore doesn't upload a local place`, async ({
    page,
  }) => {
    const f = await keptUI(page, kind);
    await page.goto('/saved');
    await page.getByRole('button', { name: 'Open saved encounter' }).click();
    await expect(page.getByTestId('keep-detail')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume saved place' })).toBeEnabled();
    expect(f.calls.filter((c) => c.path.includes('/activate') || c.path.includes('/observations/'))).toHaveLength(0);
    expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(0);
    await page.getByRole('button', { name: 'Resume saved place' }).click();
    await expect(page.getByTestId('encounter-explore')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep this place' })).toBeVisible();
    expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(0);
    expect(f.calls.filter((c) => c.path.endsWith('/experience/activate'))).toHaveLength(1);
    expect(f.calls.find((c) => c.path.endsWith('/experience/open'))?.body.target).toMatchObject({ kind: 'return' });
    if (kind === 'scroll') {
      await expect(page.getByTestId('scroll-article')).toBeVisible();
      await page.getByRole('button', { name: 'Keep this place' }).click();
      await expect.poll(() => f.calls.filter((c) => c.path.endsWith('/keep/place')).length).toBe(1);
      const sent = f.calls.find((c) => c.path.endsWith('/keep/place'))!.body;
      expect(sent.entry).toMatchObject({ savedEntryId: id(4) });
      expect(sent.position).toMatchObject({ kind: 'scroll' });
    }
    expect(page.url()).not.toContain('savedEntryId');
    expect(page.url()).not.toContain('position');
  });
}
test('a replaced membership blocks the chosen restore without creating an encounter', async ({ page }) => {
  const f = await keptUI(page, 'reel');
  await page.goto('/saved');
  await page.getByRole('button', { name: 'Open saved encounter' }).click();
  await expect(page.getByRole('button', { name: 'Resume saved place' })).toBeEnabled();
  f.replace();
  await page.getByRole('button', { name: 'Resume saved place' }).click();
  await expect(page.getByText('Your saved place needs attention')).toBeVisible();
  expect(f.calls.filter((c) => c.path.endsWith('/experience/activate'))).toHaveLength(0);
  expect(f.calls.filter((c) => c.path.includes('/observations/') || c.path.endsWith('/keep/place'))).toHaveLength(0);
});
