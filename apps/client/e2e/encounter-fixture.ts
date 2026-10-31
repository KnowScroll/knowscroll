import type { Page } from '@playwright/test';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import type { EncounterOffer, ExposureContextResponse, ScrollResults } from '@knowscroll/contracts';
import { callsOf, tallyOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';

export const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export interface EncounterFixtureOptions {
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Makes the current encounter Part 1 of a series, with Part 2 next and the other format ready. */
  readonly series?: boolean;
  /** A different Scroll document to serve for every Scroll offer (the labelled v2 fixture); the default is the v1 fixture. */
  readonly scrollDocument?: Record<string, unknown>;
  /**
   * Serves a Scroll opened by its address (`/scroll/<id>`): a direct open and activation with no session, and a
   * series of `parts` Scrolls that the context counts and links (each Part has the Part before and the Part after
   * it). `related` adds a related move on every Part. One part is no series.
   */
  readonly direct?: { readonly parts: number; readonly related?: boolean };
  /** Play on the served v2 Scroll: what the play routes already hold (a reload), and whether recording is paused (D-083). */
  readonly play?: {
    readonly kept?: readonly { readonly stopId: string; readonly option: number }[];
    readonly recordingPaused?: boolean;
  };
  /**
   * The content-request routes (Ask from here, D1): what the status read answers for a request made on this page. The
   * answers are authored here, so this proves what the screen does with them, not what the server decides.
   */
  readonly requests?: {
    /** Where the request stands: preparing (the default), ready, or closed as could-not-prepare. */
    readonly outcome?: 'preparing' | 'ready' | 'could_not_prepare';
    /** A measured usual wait in seconds; absent, as it is until five orders have finished. */
    readonly typicalSeconds?: number;
  };
}

/** Actual production-export UI with explicitly labelled HTTP fixtures, not backend/provider acceptance. */
export async function encounterFixture(page: Page, kind: 'scroll' | 'reel', options: EncounterFixtureOptions = {}) {
  await page.setViewportSize(options.viewport ?? { width: 390, height: 844 });
  const series = options.series === true;
  const other = kind === 'scroll' ? 'reel' : 'scroll';
  const variantsOf = (n: number): EncounterOffer['variants'] =>
    series
      ? [{ kind: other, status: 'ready', assetId: id(500 + n), assetRevision: document.revision }]
      : [{ kind: other, status: 'unavailable' }];
  let current = 0;
  let intentRevision = 1;
  let saved = true;
  const commands: { path: string; body: Record<string, unknown> }[] = [];
  /** Every observation event the page sent, in order. */
  const observed: { kind: string; exposureId: string; payload: Record<string, unknown> }[] = [];
  const served = options.scrollDocument ?? document;
  // Only a v2 document has stops; the v1 fixtures have no call to play. The Final call is a call like the others.
  const playable = 'stops' in served ? (served as unknown as ScrollDocumentV2) : undefined;
  const callIts = playable === undefined ? [] : callsOf(playable);
  const isFinal = (stopId: string) => callIts.find((call) => call.id === stopId)?.kind === 'final_call';
  /** The calls the play routes hold, judged from the served document as the server judges a revision. */
  const kept = (options.play?.kept ?? []).map((lock) => ({
    ...lock,
    correct: callIts.find((call) => call.id === lock.stopId)?.answer === lock.option,
  }));
  const resultsFor = (assetId: unknown, revision: unknown): ScrollResults => {
    const final = kept.find((lock) => isFinal(lock.stopId));
    return {
      assetId: String(assetId),
      revision: Number(revision),
      calls: kept.map((lock) => ({ ...lock })),
      ...tallyOf(kept.map((lock) => ({ correct: lock.correct, finalCall: isFinal(lock.stopId) }))),
      ...(final === undefined || playable?.landmark === undefined
        ? {}
        : { landmark: { ...playable.landmark, tier: final.correct ? ('gold' as const) : ('plain' as const) } }),
    };
  };
  /** What the request routes answer, and what the page asked of them. */
  const requestState = { outcome: options.requests?.outcome ?? 'preparing', requestId: id(900), retried: false };
  const requestStatus = () => {
    const base = {
      version: 'content-request-status.v1',
      requestId: requestState.requestId,
      privacyEpoch: 1,
      requestRevision: requestState.retried ? 3 : 1,
      revision: 1,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };
    if (requestState.outcome === 'ready')
      return {
        ...base,
        status: 'ready',
        content: {
          assetId: id(950),
          assetRevision: document.revision,
          explanationUnitId: 'ci-ask-order',
          metadata: { kind: 'scroll', title: 'Why the far side stays cold', summary: 'CI ask order', language: 'en' },
        },
      };
    if (requestState.outcome === 'could_not_prepare' && !requestState.retried)
      return { ...base, status: 'unavailable', reason: 'could_not_prepare' };
    return {
      ...base,
      status: 'preparing',
      phase: 'preparing',
      ...(options.requests?.typicalSeconds === undefined ? {} : { typicalSeconds: options.requests.typicalSeconds }),
    };
  };
  const recording = options.play?.recordingPaused === true ? { on: false, generation: 2 } : { on: true, generation: 1 };
  const offer = (n: number): EncounterOffer => ({
    offerId: id(100 + n),
    decisionId: id(200 + n),
    assetId: id(300 + n),
    assetRevision: document.revision,
    explanationUnitId: `ci-fixture-${String(n)}`,
    metadata: {
      kind,
      title: `CI encounter fixture ${String(n + 1)}`,
      summary: 'HTTP fixture only',
      language: 'en',
    },
    relation: { kind: 'discovery' },
    variants: variantsOf(n),
  });
  const directContext = (
    n: number,
    direct: NonNullable<EncounterFixtureOptions['direct']>,
  ): ExposureContextResponse => {
    const link = (target: number, base: number) => ({
      status: 'ready' as const,
      linkId: id(base + target),
      target: { assetId: id(300 + target), assetRevision: document.revision },
      metadata: {
        kind: 'scroll' as const,
        title: `CI encounter fixture ${String(target + 1)}`,
        summary: 'CI series link',
        language: 'en',
      },
    });
    const none = { status: 'unavailable' as const, reason: 'series_boundary' as const };
    const seriesId = 'ci-series';
    return {
      exposureId: id(400 + n),
      assetId: id(300 + n),
      assetRevision: document.revision,
      revision: 1,
      actions: { saved: false, liked: false, hidden: false },
      ...(direct.parts > 1 ? { series: { seriesId, seriesRevision: 1, part: n + 1, total: direct.parts } } : {}),
      variants: [{ kind: 'reel', status: 'unavailable' }],
      continuations: {
        seriesPrevious:
          n > 0
            ? { ...link(n - 1, 700), relation: { kind: 'series_step', seriesId, seriesRevision: 1, part: n } }
            : none,
        seriesNext:
          n + 1 < direct.parts
            ? { ...link(n + 1, 700), relation: { kind: 'series_step', seriesId, seriesRevision: 1, part: n + 2 } }
            : none,
        related:
          direct.related === true
            ? { ...link(n + 5, 800), relation: { kind: 'related_move', label: 'CI related angle' } }
            : { status: 'unavailable', reason: 'no_related_ready' },
      },
    };
  };
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      json: {
        account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'fixture@encounter.test' },
        client: 'web',
        expiresAt: '2099-10-20T10:00:00.000Z',
      },
    }),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/privacy/recording/read') {
      await route.fulfill({
        json: {
          version: 'recording-policy.v1',
          ...body,
          scope: { accountId: id(1), privacyEpoch: 1 },
          revision: 0,
          policy: recording,
        },
      });
      return;
    }
    if (path === '/v1/content/requests' && request.method() === 'POST') {
      commands.push({ path, body });
      await route.fulfill({
        json: {
          version: 'content-request-receipt.v1',
          commandId: body.commandId,
          requestId: requestState.requestId,
          recordedAt: '2026-10-20T10:00:00.000Z',
          privacyEpoch: 1,
          revision: 1,
          replayed: false,
          outcome: 'accepted',
        },
      });
      return;
    }
    if (path.startsWith('/v1/content/requests/') && request.method() === 'GET') {
      await route.fulfill({ json: requestStatus() });
      return;
    }
    if (path === '/v1/content/requests/retry') {
      commands.push({ path, body });
      requestState.retried = true;
      await route.fulfill({
        json: {
          version: 'content-request-retry-receipt.v1',
          commandId: body.commandId,
          requestId: body.requestId,
          recordedAt: '2026-10-20T10:00:00.000Z',
          privacyEpoch: 1,
          revision: 2,
          replayed: false,
          outcome: 'retrying',
        },
      });
      return;
    }
    if (path === '/v1/content/requests/cancel') {
      commands.push({ path, body });
      await route.fulfill({
        json: {
          version: 'content-request-cancel-receipt.v1',
          commandId: body.commandId,
          requestId: body.requestId,
          recordedAt: '2026-10-20T10:00:00.000Z',
          privacyEpoch: 1,
          revision: 2,
          replayed: false,
          outcome: 'cancelled',
        },
      });
      return;
    }
    if (path === '/v1/play/results/read') {
      commands.push({ path, body });
      await route.fulfill({ json: resultsFor(body.assetId, body.revision) });
      return;
    }
    if (path === '/v1/play/calls/lock') {
      commands.push({ path, body });
      const call = callIts.find((candidate) => candidate.id === body.stopId);
      if (call === undefined || recording.on === false) {
        await route.fulfill({ status: 404, json: {} });
        return;
      }
      let standing = kept.find((lock) => lock.stopId === body.stopId);
      const newlyLocked = standing === undefined;
      if (standing === undefined) {
        standing = { stopId: call.id, option: Number(body.option), correct: Number(body.option) === call.answer };
        kept.push(standing);
      }
      await route.fulfill({
        json: {
          recorded: true,
          commandId: body.commandId,
          assetId: body.assetId,
          revision: body.revision,
          stopId: standing.stopId,
          option: standing.option,
          correct: standing.correct,
          newlyLocked,
          results: resultsFor(body.assetId, body.revision),
          replayed: false,
        },
      });
      return;
    }
    if (options.direct !== undefined && path === '/v1/experience/open') {
      commands.push({ path, body });
      // The asset ids of the fixture count up from 300: the position in the series is the last digits.
      const n = Number(String((body.target as { assetId: string }).assetId).slice(-12)) - 300;
      await route.fulfill({
        json: {
          commandId: body.commandId,
          exposureId: id(400 + n),
          assetId: id(300 + n),
          assetRevision: document.revision,
          kind: 'scroll',
          openedAt: '2026-10-20T10:00:00.000Z',
          replayed: false,
          revision: 1,
        },
      });
      return;
    }
    if (options.direct !== undefined && path === '/v1/experience/activate') {
      commands.push({ path, body });
      await route.fulfill({
        json: {
          commandId: body.commandId,
          exposureId: body.exposureId,
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision: 1,
          replayed: false,
        },
      });
      return;
    }
    if (path === '/v1/experience/open' || path === '/v1/experience/navigate') {
      commands.push({ path, body });
      if (path.endsWith('/navigate')) {
        current += 1;
        intentRevision += 1;
      }
      await route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(3),
          intentRevision,
          revision: intentRevision,
          decisionId: id(4),
          replayed: false,
          status: 'ready',
          offer: offer(current),
          bufferedOffers: [],
        },
      });
      return;
    }
    if (path === '/v1/experience/activate') {
      commands.push({ path, body });
      await route.fulfill({
        json: {
          commandId: body.commandId,
          sessionId: id(3),
          intentRevision,
          offerId: offer(current).offerId,
          exposureId: id(400 + current),
          assetId: offer(current).assetId,
          assetRevision: document.revision,
          kind,
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision: intentRevision,
          replayed: false,
        },
      });
      return;
    }
    if (path.endsWith('/context')) {
      const n = Number(path.split('/').at(-2)!.slice(-12)) - 400;
      if (options.direct !== undefined) {
        await route.fulfill({ json: directContext(n, options.direct) });
        return;
      }
      const context: ExposureContextResponse = {
        exposureId: id(400 + n),
        assetId: offer(n).assetId,
        assetRevision: document.revision,
        revision: intentRevision,
        session: { sessionId: id(3), intentRevision },
        actions: { saved: false, liked: false, hidden: false },
        ...(series ? { series: { seriesId: 'ci-series', seriesRevision: 1, part: 1, total: 2 } } : {}),
        variants: variantsOf(n),
        continuations: {
          seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
          seriesNext: series
            ? {
                status: 'ready',
                linkId: id(700 + n),
                target: { assetId: id(301 + n), assetRevision: document.revision },
                metadata: { kind, title: 'CI series part 2', summary: 'CI series link', language: 'en' },
                relation: { kind: 'series_step', seriesId: 'ci-series', seriesRevision: 1, part: 2 },
              }
            : { status: 'unavailable', reason: 'series_boundary' },
          related:
            kind === 'reel' || series
              ? {
                  status: 'ready',
                  linkId: id(800 + n),
                  target: { assetId: id(301 + n), assetRevision: document.revision },
                  metadata: {
                    kind: 'reel',
                    title: `CI encounter fixture ${String(n + 2)}`,
                    summary: 'CI related link',
                    language: 'en',
                  },
                  relation: { kind: 'related_move', label: 'CI related angle' },
                }
              : { status: 'unavailable', reason: 'no_related_ready' },
        },
      };
      await route.fulfill({ json: context });
      return;
    }
    if (path === '/v1/media/grants') {
      await route.fulfill({
        json: {
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: offer(current).assetId,
            revision: document.revision,
            title: offer(current).metadata.title,
            summary: 'CI gesture fixture; no decoded playback claimed',
            language: 'en',
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
            durationMs: 20000,
            width: 1080,
            height: 1920,
          },
          path: '/media/gesture-fixture',
          expiresAt: '2099-10-20T18:00:00.000Z',
        },
      });
      return;
    }
    if (path.endsWith('/document')) {
      const n = Number(path.split('/').at(-2)!.slice(-12)) - 400;
      await route.fulfill({
        json: {
          exposureId: id(400 + n),
          assetId: offer(n).assetId,
          assetRevision: document.revision,
          document: { ...served, assetId: offer(n).assetId, title: offer(n).metadata.title },
          degradedEssential: [],
        },
      });
      return;
    }
    if (path === '/v1/saved') {
      const url = new URL(request.url());
      await route.fulfill({
        json: {
          pagination: 'saved-page.v1',
          consistency: 'live',
          filter: url.searchParams.get('filter'),
          limit: 20,
          scope: { accountId: id(1), privacyEpoch: 1 },
          ...(url.searchParams.has('cursor') ? { requestCursor: url.searchParams.get('cursor') } : {}),
          continuation: { status: 'end' },
          revision: 1,
          items: saved
            ? [
                {
                  assetId: id(990),
                  assetRevision: 2,
                  savedAt: '2026-10-20T10:00:00.000Z',
                  savedEntryId: id(992),
                  kind: 'reel',
                  availability: 'withdrawn',
                },
              ]
            : [],
        },
      });
      return;
    }
    if (path === '/v1/experience/keep/read') {
      const target = body.target as { assetId: string; assetRevision: number };
      await route.fulfill({
        json: {
          version: 'keep-place.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          target,
          status: saved ? 'saved_unavailable' : 'not_saved',
          ...(saved ? { entry: { ...target, savedEntryId: id(992) } } : {}),
        },
      });
      return;
    }
    if (path === '/v1/experience/keep/remove') {
      commands.push({ path, body });
      saved = false;
      await route.fulfill({
        json: {
          version: 'keep-remove.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          commandId: body.commandId,
          recordedAt: '2026-10-22T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.entry.remove',
          entry: body.entry,
        },
      });
      return;
    }
    if (path === '/v1/observations/recording-batch') {
      const events = body.events as {
        eventId: string;
        exposureId: string;
        kind: string;
        payload: Record<string, unknown>;
      }[];
      for (const event of events)
        observed.push({ kind: event.kind, exposureId: event.exposureId, payload: event.payload });
      await route.fulfill({
        json: {
          version: 'observation-batch.v2',
          result: 'processed',
          recordingGeneration: body.recordingGeneration,
          currentGeneration: body.recordingGeneration,
          scope: { accountId: id(1), privacyEpoch: 1 },
          accepted: events.length,
          duplicates: 0,
          rejected: 0,
          results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
          revision: 1,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  return { commands, observed };
}
