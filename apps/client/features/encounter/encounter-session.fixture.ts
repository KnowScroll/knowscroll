import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import {
  problemDetails,
  type EncounterOffer,
  type ExposureContextResponse,
  type NavigationOutcome,
  type ObservationBatchRequest,
} from '@knowscroll/contracts';
import { createEncounterSession } from './encounter-session';

/** Labelled CI HTTP fixtures: actual typed transport, AccountScope and recorder, no live backend/media. */
export const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (code: Parameters<typeof problemDetails>[0]) => json(problemDetails(code), problemDetails(code).status);
export function offer(n: number): EncounterOffer {
  return {
    offerId: id(n + 100),
    decisionId: id(n + 200),
    assetId: id(n + 300),
    assetRevision: 2,
    explanationUnitId: `fixture-${String(n)}`,
    metadata: { kind: 'reel', title: `Fixture ${String(n)}`, summary: 'CI fixture only', language: 'en' },
    relation: { kind: 'discovery' },
    variants: [{ status: 'unavailable', kind: 'scroll' }],
  };
}
export function harness() {
  let next = 1000;
  let selected = 0;
  let revision = 1;
  let openFailure = false;
  let activationFailure = false;
  let navigationStale = false;
  let actionFailure = false;
  let saved = false;
  let contextGate: Promise<void> | undefined;
  let outcomeStatus: 'ready' | 'pending' | 'exhausted' = 'ready';
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const batches: ObservationBatchRequest[] = [];
  const store = memoryStore();
  const outcome = (commandId: string): NavigationOutcome => ({
    commandId,
    sessionId: id(1),
    intentRevision: revision,
    revision,
    decisionId: id(2),
    replayed: false,
    ...(outcomeStatus === 'ready'
      ? { status: 'ready', offer: offer(selected), bufferedOffers: [] }
      : outcomeStatus === 'pending'
        ? { status: 'pending', reason: 'buffer_preparing' }
        : { status: 'exhausted', reason: 'no_eligible_content' }),
  });
  const context = (n: number): ExposureContextResponse => ({
    exposureId: id(n + 400),
    assetId: offer(n).assetId,
    assetRevision: 2,
    revision,
    session: { sessionId: id(1), intentRevision: revision },
    actions: { saved, liked: false, hidden: false },
    variants: [{ status: 'unavailable', kind: 'scroll' }],
    continuations: {
      seriesNext: { status: 'unavailable', reason: 'series_boundary' },
      seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
      related: { status: 'unavailable', reason: 'no_related_ready' },
    },
  });
  const scope = createAccountScope({
    account: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'fixture@encounter.test' },
    baseUrl: 'https://fixture.encounter.test',
    authorization: () => undefined,
    store,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? ((await request.clone().json()) as Record<string, unknown>) : {};
      calls.push({ path, body });
      if (path === '/v1/experience/open') {
        if (openFailure) throw new Error('Unknown open outcome');
        return json(outcome(String(body.commandId)));
      }
      if (path === '/v1/experience/navigate') {
        if (navigationStale) {
          revision += 1;
          return problem('INTENT_REVISION_STALE');
        }
        selected += 1;
        revision += 1;
        return json(outcome(String(body.commandId)));
      }
      if (path === '/v1/experience/activate') {
        if (activationFailure) throw new Error('Unknown activation outcome');
        return json({
          commandId: body.commandId,
          sessionId: id(1),
          offerId: offer(selected).offerId,
          intentRevision: revision,
          exposureId: id(selected + 400),
          assetId: offer(selected).assetId,
          assetRevision: 2,
          kind: 'reel',
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision,
          replayed: false,
        });
      }
      if (path.endsWith('/context')) {
        await contextGate;
        const exposure = path.split('/').at(-2)!;
        const n = Number(exposure.slice(-12)) - 400;
        return json(context(n));
      }
      if (path === '/v1/media/grants')
        return json({
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: offer(selected).assetId,
            revision: 2,
            title: 'Fixture Reel',
            summary: 'CI only',
            language: 'en',
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
            durationMs: 20000,
            width: 1080,
            height: 1920,
          },
          path: '/media/fixture',
          expiresAt: '2099-10-20T18:00:00.000Z',
        });
      if (path === '/v1/actions') {
        if (actionFailure) throw new Error('Unknown action outcome');
        saved = body.kind === 'save';
        return json({
          commandId: body.commandId,
          actionId: id(9),
          kind: body.kind,
          assetId: offer(selected).assetId,
          assetRevision: 2,
          saved,
          changed: true,
          revision,
          replayed: false,
        });
      }
      if (path === '/v1/observations/batch') {
        const batch = body as unknown as ObservationBatchRequest;
        batches.push(batch);
        return json({
          accepted: batch.events.length,
          duplicates: 0,
          rejected: 0,
          revision,
          results: batch.events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
        });
      }
      return json({ revision, items: [] });
    },
  });
  const session = createEncounterSession(scope, () => id(++next));
  return {
    scope,
    store,
    session,
    calls,
    batches,
    setOpenFailure: (value: boolean) => {
      openFailure = value;
    },
    setActivationFailure: (value: boolean) => {
      activationFailure = value;
    },
    setStale: (value: boolean) => {
      navigationStale = value;
    },
    setActionFailure: (value: boolean) => {
      actionFailure = value;
    },
    setGate: (value: Promise<void> | undefined) => {
      contextGate = value;
    },
    setSaved: (value: boolean) => {
      saved = value;
    },
    setOutcome: (value: typeof outcomeStatus) => {
      outcomeStatus = value;
    },
  };
}
