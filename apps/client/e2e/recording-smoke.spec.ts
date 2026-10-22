import { expect, test } from '@playwright/test';
import sourceDocument from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { computeIntegrity, parseDocument } from '@knowscroll/scroll-model';
import type { RecordingObservationBatchRequest, SetRecordingPolicy } from '@knowscroll/contracts';

/** Production export + authored HTTP fixtures. No real backend, growth or native/device claim. */
test('Pause unknown retry, necessary paused Save, and fresh activation after Resume', async ({ page }) => {
  const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const scope = { accountId: id(1), privacyEpoch: 1 };
  const parsed = parseDocument({ ...sourceDocument, assetId: id(3) });
  if (parsed.kind !== 'valid') throw new Error('Authored canonical Scroll fixture');
  const document = {
    ...parsed.document,
    integrity: { ...parsed.document.integrity, sha256: computeIntegrity(parsed.document) },
  };
  let generation = 1;
  let loseReply = true;
  let saved = false;
  let exposure = 10;
  const sets: SetRecordingPolicy[] = [];
  const actions: Record<string, unknown>[] = [];
  const activations: { commandId: string; recordingGeneration?: number }[] = [];
  const observations: RecordingObservationBatchRequest[] = [];
  const receipts = new Map<string, object>();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(
    ({ key }) => {
      if (localStorage.getItem('recording-ci-seeded')) return;
      localStorage.setItem(
        key,
        JSON.stringify({ v: 1, dropped: 0, batches: [{ instrumentationVersion: 1, events: [] }] }),
      );
      localStorage.setItem('recording-ci-seeded', 'yes');
    },
    { key: `ks.scope.${id(1)}:1.recorder.outbox.v1` },
  );
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      json: {
        account: { ...scope, universeId: id(2), email: 'recording@fixture.test' },
        client: 'web',
        expiresAt: '2099-10-23T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : {};
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          version: 'recording-policy.v1',
          ...body,
          scope,
          revision: generation,
          policy: { on: generation % 2 === 1, generation },
        },
      });
    if (path === '/v1/privacy/recording/set') {
      const command = body as unknown as SetRecordingPolicy;
      sets.push(command);
      let receipt = receipts.get(command.commandId);
      const replayed = receipt !== undefined;
      if (!receipt) {
        const fromGeneration = generation;
        if (command.on !== (generation % 2 === 1)) generation++;
        receipt = {
          commandId: command.commandId,
          requestedPrivacyEpoch: 1,
          fromGeneration,
          toGeneration: generation,
          on: command.on,
          changed: generation !== fromGeneration,
          recordedAt: '2026-10-23T00:00:00.000Z',
        };
        receipts.set(command.commandId, receipt);
      }
      if (loseReply) {
        loseReply = false;
        return route.abort('failed');
      }
      return route.fulfill({
        json: {
          version: 'recording-policy.v1',
          operation: 'privacy.recording-set',
          outcome: 'accepted',
          receipt,
          replayed,
        },
      });
    }
    if (path === '/v1/experience/open') {
      expect(Object.hasOwn(body, 'recordingGeneration')).toBe(false); // Direct open deliberately forbids it.
      exposure++;
      return route.fulfill({
        json: {
          commandId: body.commandId,
          exposureId: id(exposure),
          assetId: id(3),
          assetRevision: document.revision,
          kind: 'scroll',
          openedAt: '2026-10-23T00:00:00.000Z',
          replayed: false,
          revision: generation,
        },
      });
    }
    if (path.endsWith('/document'))
      return route.fulfill({
        json: {
          exposureId: id(exposure),
          assetId: id(3),
          assetRevision: document.revision,
          document,
          degradedEssential: [],
        },
      });
    if (path === '/v1/experience/activate') {
      activations.push(body as { commandId: string; recordingGeneration?: number });
      return route.fulfill({
        json: {
          commandId: body.commandId,
          exposureId: body.exposureId,
          activatedAt: '2026-10-23T00:00:00.000Z',
          revision: generation,
          replayed: false,
        },
      });
    }
    if (path.endsWith('/keep/read'))
      return route.fulfill({
        json: {
          version: 'keep-place.v1',
          scope,
          target: body.target,
          ...(saved
            ? {
                status: 'available',
                entry: { assetId: id(3), assetRevision: document.revision, savedEntryId: id(20) },
                place: { status: 'none', placeRevision: 0 },
              }
            : { status: 'not_saved' }),
        },
      });
    if (path === '/v1/actions') {
      actions.push(body);
      saved = true;
      return route.fulfill({
        json: {
          commandId: body.commandId,
          actionId: id(21),
          kind: 'save',
          assetId: id(3),
          assetRevision: document.revision,
          saved: true,
          changed: true,
          revision: generation,
          replayed: false,
        },
      });
    }
    if (path.endsWith('/keep/place'))
      return route.fulfill({
        json: {
          version: 'keep-place.v1',
          scope,
          commandId: body.commandId,
          recordedAt: '2026-10-23T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.place.set',
          entry: body.entry,
          basePlaceRevision: body.expectedPlaceRevision,
          acceptedPlaceRevision: Number(body.expectedPlaceRevision) + 1,
        },
      });
    if (path === '/v1/observations/recording-batch') {
      const batch = body as unknown as RecordingObservationBatchRequest;
      observations.push(batch);
      return route.fulfill({
        json: {
          version: 'observation-batch.v2',
          recordingGeneration: batch.recordingGeneration,
          currentGeneration: generation,
          scope,
          revision: generation,
          result: 'processed',
          accepted: batch.events.length,
          duplicates: 0,
          rejected: 0,
          results: batch.events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
        },
      });
    }
    // Clear is independently unavailable in this recording-only fixture.
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/account/privacy');
  await page.getByRole('button', { name: 'Pause recording', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry the same recording choice' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume recording', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry the same recording choice' }).click();
  await expect(page.getByRole('button', { name: 'Resume recording', exact: true })).toBeVisible();
  expect(sets[1]).toEqual(sets[0]);
  await expect(page.getByText(/1 group of unuploaded activity was discarded/)).toBeVisible();
  await page.goto(`/scroll/${id(3)}`);
  await expect(page.getByTestId('scroll-article')).toBeVisible();
  await page.getByRole('button', { name: 'Save to Keep', exact: true }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]?.recordingGeneration).toBe(2);
  expect(activations[0]?.recordingGeneration).toBe(2);
  expect(observations).toEqual([]);
  await page.goto('/account/privacy');
  await page.getByRole('button', { name: 'Resume recording', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause recording', exact: true })).toBeVisible();
  await page.goto(`/scroll/${id(3)}`);
  await expect(page.getByTestId('scroll-article')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(() => observations.length).toBeGreaterThan(0);
  expect(activations.at(-1)?.recordingGeneration).toBe(3);
  expect(
    observations.every(
      (batch) =>
        batch.recordingGeneration === 3 &&
        batch.events.every((event) => event.sessionId === activations.at(-1)?.commandId),
    ),
  ).toBe(true);
});
