import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import {
  problemDetails,
  type EncounterOffer,
  type ExposureContextResponse,
  type NavigationOutcome,
  type RecordingObservationBatchRequest,
} from '@knowscroll/contracts';
import scrollDocument from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { createEncounterSession } from './encounter-session';

/** Labelled CI HTTP fixtures: actual typed transport, AccountScope and recorder, no live backend/media. */
export const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (code: Parameters<typeof problemDetails>[0]) => json(problemDetails(code), problemDetails(code).status);
/** What an offer is: a Reel, a Scroll without a cover, or a Scroll that carries one (`offer-cover.v1`). */
export type OfferSpec = 'reel' | 'scroll' | 'cover';
export function offer(n: number, spec: OfferSpec = 'reel'): EncounterOffer {
  const scroll = spec !== 'reel';
  return {
    offerId: id(n + 100),
    decisionId: id(n + 200),
    assetId: id(n + 300),
    // A Scroll's revision is its fixture document's, so the served document and the offer name the same one.
    assetRevision: scroll ? scrollDocument.revision : 2,
    explanationUnitId: `fixture-${String(n)}`,
    metadata: {
      kind: scroll ? 'scroll' : 'reel',
      title: `Fixture ${String(n)}`,
      summary: 'CI fixture only',
      language: 'en',
    },
    ...(spec === 'cover'
      ? { cover: { version: 'offer-cover.v1' as const, kicker: `Fixture kicker ${String(n)}`, readingMinutes: 4 } }
      : {}),
    relation: { kind: 'discovery' },
    variants: [{ status: 'unavailable', kind: scroll ? 'reel' : 'scroll' }],
  };
}
export function harness() {
  let next = 1000;
  let recordingGeneration = 1;
  let selected = 0;
  let outcomeSessionId = id(1);
  let revision = 1;
  let openFailure = false;
  let activationFailure = false;
  let navigationStale = false;
  let actionFailure = false;
  let feedbackFailure = false;
  let saved = false;
  let contextNotFound = false;
  let contextGate: Promise<void> | undefined;
  let bufferedCount = 0;
  let offerSpecs: readonly OfferSpec[] | undefined;
  let activationProblem: Parameters<typeof problemDetails>[0] | undefined;
  /** Every offer the fixture has served, so context, document and activation answer for the offer's own kind. */
  const served = new Map<number, EncounterOffer>();
  const servedOffer = (n: number) => served.get(n) ?? offer(n);
  let outcomeStatus: 'ready' | 'pending' | 'exhausted' = 'ready';
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const batches: RecordingObservationBatchRequest[] = [];
  const store = memoryStore();
  const offersOf = () => {
    const specs = offerSpecs ?? Array.from<OfferSpec>({ length: 1 + bufferedCount }).fill('reel');
    const made = specs.map((spec, index) => {
      const n = index === 0 ? selected : selected + 9 + index;
      const made = offer(n, spec);
      served.set(n, made);
      return made;
    });
    return { offer: made[0]!, bufferedOffers: made.slice(1) };
  };
  const outcome = (commandId: string): NavigationOutcome => ({
    commandId,
    sessionId: outcomeSessionId,
    intentRevision: revision,
    revision,
    decisionId: id(2),
    replayed: false,
    ...(outcomeStatus === 'ready'
      ? {
          status: 'ready',
          ...offersOf(),
        }
      : outcomeStatus === 'pending'
        ? { status: 'pending', reason: 'buffer_preparing' }
        : { status: 'exhausted', reason: 'no_eligible_content' }),
  });
  const context = (n: number): ExposureContextResponse => ({
    exposureId: id(n + 400),
    assetId: servedOffer(n).assetId,
    assetRevision: servedOffer(n).assetRevision,
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
      // Explicit current-policy HTTP fixture; independent of the encounter/Keep command log.
      if (path === '/v1/privacy/recording/read')
        return request
          .clone()
          .json()
          .then((input: { readId: string; target: unknown }) => {
            const claim = request.headers.get('x-ks-scope')!.split(':');
            return new Response(
              JSON.stringify({
                version: 'recording-policy.v1',
                ...input,
                scope: { accountId: claim[0], privacyEpoch: Number(claim[1]) },
                revision: recordingGeneration,
                policy: { on: recordingGeneration % 2 === 1, generation: recordingGeneration },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          });
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
        if (activationProblem) return problem(activationProblem);
        // The fixture activates whichever of the ranked offers the request names.
        const picked = Number((body.target as { offerId: string }).offerId.slice(-12)) - 100;
        if (picked !== selected) selected = picked;
        return json({
          commandId: body.commandId,
          sessionId: id(1),
          offerId: servedOffer(selected).offerId,
          intentRevision: revision,
          exposureId: id(selected + 400),
          assetId: servedOffer(selected).assetId,
          assetRevision: servedOffer(selected).assetRevision,
          kind: servedOffer(selected).metadata.kind,
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision,
          replayed: false,
        });
      }
      if (path.endsWith('/context')) {
        await contextGate;
        if (contextNotFound) return problem('ASSET_NOT_FOUND');
        const exposure = path.split('/').at(-2)!;
        const n = Number(exposure.slice(-12)) - 400;
        return json(context(n));
      }
      if (path.endsWith('/document')) {
        const n = Number(path.split('/').at(-2)!.slice(-12)) - 400;
        return json({
          exposureId: id(n + 400),
          assetId: servedOffer(n).assetId,
          assetRevision: servedOffer(n).assetRevision,
          // A v1 fixture document, rebound to the offer's asset; the device does not verify the hash.
          document: { ...scrollDocument, assetId: servedOffer(n).assetId },
          degradedEssential: [],
        });
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
      if (path === '/v1/feedback/not-interested' || path === '/v1/feedback/not-interested/undo') {
        if (feedbackFailure) throw new Error('Unknown feedback outcome');
        return json({
          commandId: body.commandId,
          assetId: body.assetId,
          ...(path.endsWith('/undo') ? {} : { expiresAt: '2026-11-07T12:00:00.000Z' }),
          replayed: false,
        });
      }
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
      if (path === '/v1/observations/recording-batch') {
        const batch = body as unknown as RecordingObservationBatchRequest;
        batches.push(batch);
        return json({
          version: 'observation-batch.v2',
          result: 'processed',
          recordingGeneration: batch.recordingGeneration,
          currentGeneration: batch.recordingGeneration,
          scope: { accountId: id(3), privacyEpoch: 1 },
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
  scope.recording?.useIdSource(() => id(++next));
  const session = createEncounterSession(scope, () => id(++next));
  return {
    scope,
    store,
    session,
    calls,
    batches,
    setRecordingGeneration: (value: number) => {
      recordingGeneration = value;
    },
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
    setFeedbackFailure: (value: boolean) => {
      feedbackFailure = value;
    },
    setContextNotFound: (value: boolean) => {
      contextNotFound = value;
    },
    setGate: (value: Promise<void> | undefined) => {
      contextGate = value;
    },
    setSaved: (value: boolean) => {
      saved = value;
    },
    setOutcomeSession: (value: string) => {
      outcomeSessionId = value;
    },
    /** How many further offers a ready outcome carries beside the first. */
    setBuffered: (value: number) => {
      bufferedCount = value;
    },
    /**
     * The offers each outcome carries, the first then the buffered ones, overriding `setBuffered`: Reels, Scrolls without
     * a cover, or Scrolls with one. Unset, every offer is a Reel.
     */
    setOffers: (value: readonly OfferSpec[] | undefined) => {
      offerSpecs = value;
    },
    /** Makes activation answer with this API problem, as the server does for a spent offer or a moved session. */
    setActivationProblem: (value: typeof activationProblem) => {
      activationProblem = value;
    },
    /** Registers an offer the fixture did not generate itself (a region card's), so activation and context serve it. */
    serve: (n: number, spec: OfferSpec) => {
      const made = offer(n, spec);
      served.set(n, made);
      return made;
    },
    setOutcome: (value: typeof outcomeStatus) => {
      outcomeStatus = value;
    },
  };
}
