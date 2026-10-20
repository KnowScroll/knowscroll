import { waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore, scopeOutbox } from '@knowscroll/client-core';
import {
  problemDetails,
  type EncounterOffer,
  type ExposureContextResponse,
  type NavigationOutcome,
  type ObservationBatchRequest,
  type OpenExposureRequest,
} from '@knowscroll/contracts';
import { createEncounterSession, type EncounterSession } from './encounter-session';

/** Labelled CI HTTP fixtures: actual typed transport, AccountScope and recorder, no live backend/media. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (code: Parameters<typeof problemDetails>[0]) => json(problemDetails(code), problemDetails(code).status);
function offer(n: number): EncounterOffer {
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
function harness() {
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
    setOutcome: (value: typeof outcomeStatus) => {
      outcomeStatus = value;
    },
  };
}
function waitForPhase(
  session: EncounterSession,
  phase: ReturnType<EncounterSession['getState']>['phase'],
): Promise<void> {
  if (session.getState().phase === phase) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe(() => {
      if (session.getState().phase === phase) {
        unsubscribe();
        resolve();
      }
    });
  });
}
async function ready(h: ReturnType<typeof harness>) {
  h.session.setForeground(true);
  h.session.open({ kind: 'discover' });
  await waitForPhase(h.session, 'active');
  const entry = h.session.getState().entry!;
  h.session.mount(entry);
  return entry;
}
const commands = (h: ReturnType<typeof harness>, suffix: string) =>
  h.calls.filter((call) => call.path.endsWith(suffix));

describe('actual encounter controller over CI transport fixtures', () => {
  it('reuses both command IDs after unknown outcomes and never activates a background offer', async () => {
    const h = harness();
    try {
      h.setOpenFailure(true);
      h.session.open({ kind: 'discover' });
      await waitForPhase(h.session, 'offline');
      h.setOpenFailure(false);
      h.session.retry();
      await waitForPhase(h.session, 'ready_offer');
      expect(commands(h, '/open').map((call) => call.body.commandId)).toEqual([
        commands(h, '/open')[0]!.body.commandId,
        commands(h, '/open')[0]!.body.commandId,
      ]);
      expect(commands(h, '/activate')).toHaveLength(0);
      h.setActivationFailure(true);
      h.session.setForeground(true);
      await waitForPhase(h.session, 'offline');
      h.setActivationFailure(false);
      h.session.retry();
      await waitForPhase(h.session, 'active');
      expect(commands(h, '/activate')).toHaveLength(2);
      expect(commands(h, '/activate')[1]!.body).toEqual(commands(h, '/activate')[0]!.body);
      expect(commands(h, '/open')).toHaveLength(2);
    } finally {
      h.scope.end();
    }
  });

  it('captures before pause, restores Back locally with the same recorder/timebase and uses the latest intent from a parked member', async () => {
    const h = harness();
    let now = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const first = await ready(h);
      const order: string[] = [];
      first.surface = {
        capture: () => {
          order.push('capture');
          return { kind: 'reel', positionMs: 12345 };
        },
        pause: () => {
          order.push('pause');
        },
      };
      const originalSuspend = first.recorder.suspend.bind(first.recorder);
      const suspend = jest.spyOn(first.recorder, 'suspend').mockImplementation(() => {
        order.push('suspend');
        originalSuspend();
      });
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      expect(order).toEqual(['capture', 'pause', 'suspend']);
      suspend.mockRestore();
      const count = h.calls.length;
      const handle = first.recorder;
      expect(h.session.back()).toBe(true);
      expect(h.calls).toHaveLength(count);
      expect(h.session.getState().entry?.recorder).toBe(handle);
      expect(h.session.getState().entry?.position).toEqual({ kind: 'reel', positionMs: 12345 });
      expect(h.session.getState().entry?.restored).toBe(true);
      h.session.mount(first);
      if (first.kind !== 'reel') throw new Error('Reel fixture');
      now = 5000;
      first.recorder.sample({ positionMs: 12345, monotonicMs: now, playing: true, visible: true, buffering: false });
      now = 5500;
      first.recorder.sample({ positionMs: 12845, monotonicMs: now, playing: true, visible: true, buffering: false });
      first.recorder.flush();
      await scopeOutbox(h.scope).drain();
      const event = h.batches.flatMap((batch) => batch.events).find((item) => item.kind === 'reel.playback');
      expect(event?.sessionId).toBe(handle.sessionId);
      expect(event?.kind === 'reel.playback' && event.payload.samples[0]?.activeMs).toEqual([4000, 4500]);
      h.session.navigate({ mode: 'related' });
      await waitForPhase(h.session, 'active');
      const input = commands(h, '/navigate').at(-1)!.body;
      expect(input.from).toEqual({ offerId: first.offer.offerId, exposureId: first.exposureId });
      expect(input.expectedIntentRevision).toBe(2);
    } finally {
      h.scope.end();
      jest.restoreAllMocks();
    }
  });

  it('drops a late document/context response after scope end and purges resume data without resurrection', async () => {
    const h = harness();
    let release: () => void = () => undefined;
    h.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    h.session.setForeground(true);
    h.session.open({ kind: 'discover' });
    await waitForPhase(h.session, 'activating');
    await waitFor(() => expect(h.calls.some((call) => call.path.endsWith('/context'))).toBe(true));
    h.scope.storage.set('encounter.resume.fixture.2', '{}');
    h.scope.end();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.session.getState()).toMatchObject({ phase: 'revoked', trail: [] });
    expect(h.store.keys()).toEqual([]);
    expect(commands(h, '/grants')).toHaveLength(0);
    h.session.open({ kind: 'discover' });
    expect(commands(h, '/open')).toHaveLength(1);
  });

  it('refreshes a stale intent without resubmitting it and requires a deliberate move', async () => {
    const h = harness();
    try {
      await ready(h);
      h.setStale(true);
      h.session.navigate({ mode: 'related' });
      await waitForPhase(h.session, 'stale');
      h.session.retry();
      await h.session.refreshContext();
      expect(commands(h, '/navigate')).toHaveLength(1);
      h.session.acknowledgeStale();
      h.setStale(false);
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      expect(commands(h, '/navigate')).toHaveLength(2);
      expect(commands(h, '/navigate')[1]!.body.expectedIntentRevision).toBe(2);
      expect(commands(h, '/navigate')[1]!.body.commandId).not.toBe(commands(h, '/navigate')[0]!.body.commandId);
    } finally {
      h.scope.end();
    }
  });

  it.each(['pending', 'exhausted'] as const)(
    '%s preserves the current member and creates no phantom activation',
    async (status) => {
      const h = harness();
      try {
        const first = await ready(h);
        h.setOutcome(status);
        h.session.navigate({ mode: 'vertical', direction: 'next' });
        await waitForPhase(h.session, status);
        expect(h.session.getState().entry).toBe(first);
        expect(commands(h, '/activate')).toHaveLength(1);
        expect(h.session.getState().trail).toHaveLength(1);
        h.session.resumeCurrent();
        expect(h.session.getState().phase).toBe('active');
      } finally {
        h.scope.end();
      }
    },
  );

  it('rolls an unknown action back and retries its exact exposure-linked command', async () => {
    const h = harness();
    try {
      const entry = await ready(h);
      h.setActionFailure(true);
      h.session.act('save');
      await new Promise<void>((resolve) => {
        const unsubscribe = h.session.subscribe(() => {
          if (h.session.getState().actionFailed && !h.session.getState().actionPending) {
            unsubscribe();
            resolve();
          }
        });
      });
      expect(entry.context.actions.saved).toBe(false);
      h.setActionFailure(false);
      h.session.retryAction();
      await new Promise<void>((resolve) => {
        const unsubscribe = h.session.subscribe(() => {
          if (!h.session.getState().actionFailed && !h.session.getState().actionPending) {
            unsubscribe();
            resolve();
          }
        });
      });
      expect(entry.context.actions.saved).toBe(true);
      expect(commands(h, '/actions')[0]!.body).toEqual(commands(h, '/actions')[1]!.body);
      expect(commands(h, '/actions')[0]!.body.exposureId).toBe(entry.exposureId);
    } finally {
      h.scope.end();
    }
  });

  it('explicit Saved revisit sends the immutable revision without a local position on the wire', async () => {
    const h = harness();
    try {
      h.session.setForeground(true);
      h.session.open({ kind: 'return', assetId: offer(0).assetId, assetRevision: 2 });
      await waitForPhase(h.session, 'active');
      const input = commands(h, '/open')[0]!.body as unknown as OpenExposureRequest;
      expect(input.target).toEqual({ kind: 'return', assetId: offer(0).assetId, assetRevision: 2 });
      expect(JSON.stringify(input)).not.toMatch(/positionMs|blockId|offsetWithinBlock/);
    } finally {
      h.scope.end();
    }
  });
});
