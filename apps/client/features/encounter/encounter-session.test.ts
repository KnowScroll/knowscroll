import { waitFor } from '@testing-library/react-native';
import { scopeOutbox, createAccountScope, memoryStore } from '@knowscroll/client-core';
import type { OpenExposureRequest } from '@knowscroll/contracts';
import { createEncounterSession, type EncounterSession } from './encounter-session';
import type { AvailableKeep } from '../saved/keep-place-bridge';
import type { SetKeepPlace } from '@knowscroll/contracts';
import scrollDocument from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { parseDocument, computeIntegrity } from '@knowscroll/scroll-model';
import { retainReelMuted } from './encounter-history';
import { harness, id, offer } from './encounter-session.fixture';

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
      // The backend uses this declaration for eligibility; a capable Reel player must advertise it.
      expect((commands(h, '/open')[0]!.body.capabilities as { documentSchemas: string[] }).documentSchemas).toEqual(
        expect.arrayContaining(['scroll-document.v1', 'reel-document.v1']),
      );
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
          return { kind: 'reel', positionMs: 12345, playing: true, muted: true };
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
      expect(h.session.getState().entry?.position).toEqual({
        kind: 'reel',
        positionMs: 12345,
        playing: true,
        muted: true,
      });
      expect(h.session.getState().entry?.restored).toBe(true);
      h.session.mount(first);
      if (first.kind !== 'reel') throw new Error('Reel fixture');
      now = 5000;
      first.recorder.sample({ positionMs: 12345, monotonicMs: now, playing: true, visible: true, buffering: false });
      now = 5500;
      first.recorder.sample({ positionMs: 12845, monotonicMs: now, playing: true, visible: true, buffering: false });
      first.recorder.flush();
      await scopeOutbox(h.scope).drain();
      await waitFor(() =>
        expect(h.batches.flatMap((batch) => batch.events).some((item) => item.kind === 'reel.playback')).toBe(true),
      );
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

  it('retrying an unknown action after Back only reconciles its originating entry', async () => {
    const h = harness();
    try {
      const previous = await ready(h);
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      const origin = h.session.getState().entry!;
      h.setActionFailure(true);
      h.session.act('save');
      await waitFor(() => expect(h.session.getState()).toMatchObject({ actionFailed: true, actionPending: false }));
      expect(origin.context.actions.saved).toBe(false);
      expect(h.session.back()).toBe(true);
      expect(h.session.getState().entry).toBe(previous);
      const previousActions = previous.context.actions;
      h.setActionFailure(false);
      h.session.retryAction();
      // The optimistic update must also target the parked origin, before the reply arrives.
      expect(origin.context.actions.saved).toBe(true);
      expect(previous.context.actions).toBe(previousActions);
      await waitFor(() => expect(h.session.getState()).toMatchObject({ actionFailed: false, actionPending: false }));
      expect(origin.context.actions.saved).toBe(true);
      expect(previous.context.actions).toBe(previousActions);
      expect(previous.context.actions.saved).toBe(false);
      expect(h.session.getState().entry).toBe(previous);
      expect(commands(h, '/actions')[1]!.body).toEqual(commands(h, '/actions')[0]!.body);
      expect(commands(h, '/actions')[1]!.body.exposureId).toBe(origin.exposureId);
    } finally {
      h.scope.end();
    }
  });

  it('ignores a deferred departed-entry context refusal after Back to an authorized member', async () => {
    const h = harness();
    try {
      const previous = await ready(h);
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      const departed = h.session.getState().entry!;
      let release: () => void = () => undefined;
      h.setGate(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const count = commands(h, '/context').length;
      const refreshing = h.session.refreshContext();
      await waitFor(() => expect(commands(h, '/context')).toHaveLength(count + 1));
      expect(h.session.back()).toBe(true);
      h.setContextNotFound(true);
      release();
      await refreshing;
      expect(h.session.getState().phase).toBe('active');
      expect(h.session.getState().entry).toBe(previous);
      expect(h.session.getState().entry).not.toBe(departed);
      expect(h.session.getState().contextReady).toBeUndefined();
    } finally {
      h.scope.end();
    }
  });

  it('previous-subject Reel intent is a new command distinct from local Back', async () => {
    const h = harness();
    try {
      await ready(h);
      h.session.gesture('subjectPrevious');
      await waitForPhase(h.session, 'active');
      expect(commands(h, '/navigate')[0]!.body.intent).toEqual({ mode: 'vertical', direction: 'previous' });
      expect(commands(h, '/activate')).toHaveLength(2);
      const count = commands(h, '/navigate').length;
      h.session.back();
      expect(commands(h, '/navigate')).toHaveLength(count);
    } finally {
      h.scope.end();
    }
  });

  it('an evicted entry cannot regain an in-memory media grant through a retained callback', async () => {
    const h = harness();
    try {
      const first = await ready(h);
      const retained = h.session.mediaGrant(first);
      expect(retained.active()).toBe(true);
      expect(retained.get()).toBeDefined();
      for (let index = 0; index < 20; index += 1) {
        h.session.navigate({ mode: 'vertical', direction: 'next' });
        await waitForPhase(h.session, 'active');
      }
      expect(first.disposed).toBe(true);
      expect(retained.active()).toBe(false);
      retained.set({ path: '/media/late-fixture', expiresAt: '2099-10-20T18:00:00.000Z' });
      expect(retained.get()).toBeUndefined();
      expect(first.kind === 'reel' && first.mediaGrant).toBeUndefined();
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
      expect(input.capabilities.documentSchemas).toEqual(
        expect.arrayContaining(['scroll-document.v1', 'reel-document.v1']),
      );
      expect(JSON.stringify(input)).not.toMatch(/positionMs|blockId|offsetWithinBlock/);
    } finally {
      h.scope.end();
    }
  });
});

describe('request overlay ownership', () => {
  it('parks before opening, creates no encounter or observations, and Back restores paused sound/position', async () => {
    const h = harness();
    try {
      const entry = await ready(h);
      retainReelMuted(h.scope, entry, true);
      const calls = h.calls.length;
      const events = h.batches.length;
      const order: string[] = [];
      entry.surface = {
        capture: () => {
          order.push('capture');
          return { kind: 'reel', positionMs: 12345, playing: true, muted: true };
        },
        pause: () => {
          order.push('pause');
        },
      };
      h.session.openRequest('scroll');
      expect(order).toEqual(['capture', 'pause']);
      expect(h.session.getState()).toMatchObject({ overlay: true, overlayOwner: 'request' });
      expect(h.session.getState().entry).toBe(entry);
      expect(h.session.getState().trail).toHaveLength(1);
      expect(h.calls).toHaveLength(calls);
      expect(h.batches).toHaveLength(events);
      expect(h.session.requests.getState().source).toEqual({
        exposureId: entry.exposureId,
        assetId: entry.offer.assetId,
        assetRevision: 2,
        session: { sessionId: entry.sessionId, expectedIntentRevision: 1 },
      });
      h.session.setForeground(false);
      expect(h.session.back()).toBe(true);
      expect(h.session.getState().overlay).toBe(false);
      expect(entry.restored).toBe(true);
      expect(entry.position).toEqual({ kind: 'reel', positionMs: 12345, playing: true, muted: true });
      expect(entry.kind === 'reel' && entry.muted).toBe(true);
      expect(h.calls).toHaveLength(calls);
    } finally {
      h.scope.end();
    }
  });
  it('changes path ownership to Ask without another history member and purges private draft on scope end', async () => {
    const h = harness();
    try {
      await ready(h);
      h.session.setOverlay(true);
      h.session.openRequest();
      h.session.requests.edit({ text: 'private draft' });
      expect(h.session.getState()).toMatchObject({ overlay: true, overlayOwner: 'request' });
      expect(h.session.getState().trail).toHaveLength(1);
      h.scope.end();
      expect(h.session.requests.getState().text).toBe('');
      expect(h.session.requests.getState().source).toBeUndefined();
      expect(h.session.getState().trail).toEqual([]);
    } finally {
      h.scope.end();
    }
  });
  it('freezes latest intent for a parked member of the same session and refuses a different global session', async () => {
    const h = harness();
    try {
      const first = await ready(h);
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      h.session.back();
      h.session.openRequest('scroll');
      expect(h.session.requests.getState().source).toEqual({
        exposureId: first.exposureId,
        assetId: first.offer.assetId,
        assetRevision: first.offer.assetRevision,
        session: { sessionId: first.sessionId, expectedIntentRevision: 2 },
      });
      h.session.back();
      h.setOutcome('pending');
      h.setOutcomeSession(id(999));
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'pending');
      h.session.resumeCurrent();
      h.session.openRequest('scroll');
      expect(h.session.requests.getState().source).toBeUndefined();
      h.session.requests.submit();
      expect(h.session.requests.getState().error).toBe('source');
      expect(h.calls.filter((call) => call.path === '/v1/content/requests')).toEqual([]);
      expect(h.session.getState().entry).toBe(first);
    } finally {
      h.scope.end();
    }
  });
});

// Expo's native Jest mock intentionally returns no UUID. This labelled fixture supplies valid command IDs only.
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const jsonFixture = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
/** Authored HTTP fixture over real AccountScope, Keep session and encounter Work; no backend/media. */
function keptFixture(kind: 'reel' | 'scroll' = 'reel') {
  let next = 5000;
  let membership = id(900);
  let placeRevision = 1;
  let block: string = scrollDocument.sections[0]!.blocks[0]!.id;
  let position =
    kind === 'reel'
      ? { kind: 'reel' as const, positionMs: 12345.5 }
      : { kind: 'scroll' as const, blockId: block, offsetWithinBlock: 37.5 };
  let replaceOnDocument = false;
  let readGate: Promise<void> | undefined;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const parsed = parseDocument({ ...scrollDocument, assetId: offer(0).assetId });
  if (parsed.kind !== 'valid') throw new Error('Canonical authored Scroll fixture');
  const boundDocument = {
    ...parsed.document,
    integrity: { ...parsed.document.integrity, sha256: computeIntegrity(parsed.document) },
  };
  if (parseDocument(boundDocument, { verify: true }).kind !== 'valid')
    throw new Error('Canonical UUID-bound fixture must verify');
  const chosen = {
    ...offer(0),
    assetId: offer(0).assetId,
    assetRevision: kind === 'scroll' ? scrollDocument.revision : 2,
    metadata: { ...offer(0).metadata, kind },
    relation: { kind: 'return' as const },
  };
  const snapshot = (): AvailableKeep => ({
    version: 'keep-place.v1',
    scope: { accountId: id(3), privacyEpoch: 1 },
    target: { assetId: chosen.assetId, assetRevision: chosen.assetRevision },
    status: 'available',
    entry: { assetId: chosen.assetId, assetRevision: chosen.assetRevision, savedEntryId: membership },
    place: { status: 'set', placeRevision, position },
  });
  const scope = createAccountScope({
    account: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'kept@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const context = {
        exposureId: id(400),
        assetId: chosen.assetId,
        assetRevision: chosen.assetRevision,
        revision: 1,
        session: { sessionId: id(1), intentRevision: 1 },
        actions: { saved: true, liked: false, hidden: false },
        variants: [],
        continuations: {
          seriesNext: { status: 'unavailable', reason: 'series_boundary' },
          seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
          related: { status: 'unavailable', reason: 'no_related_ready' },
        },
      };
      if (path.endsWith('/keep/read')) {
        await readGate;
        return jsonFixture(snapshot());
      }
      if (path.endsWith('/keep/place')) {
        const b = body as unknown as SetKeepPlace;
        position = b.position;
        placeRevision = b.expectedPlaceRevision + 1;
        return jsonFixture({
          version: 'keep-place.v1',
          scope: snapshot().scope,
          commandId: b.commandId,
          recordedAt: '2026-10-22T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.place.set',
          entry: b.entry,
          basePlaceRevision: b.expectedPlaceRevision,
          acceptedPlaceRevision: placeRevision,
        });
      }
      if (path.endsWith('/open'))
        return jsonFixture({
          commandId: body.commandId,
          sessionId: id(1),
          intentRevision: 1,
          revision: 1,
          decisionId: id(2),
          replayed: false,
          status: 'ready',
          offer: chosen,
          bufferedOffers: [],
        });
      if (path.endsWith('/activate'))
        return jsonFixture({
          commandId: body.commandId,
          sessionId: id(1),
          intentRevision: 1,
          offerId: chosen.offerId,
          exposureId: id(400),
          assetId: chosen.assetId,
          assetRevision: chosen.assetRevision,
          kind,
          activatedAt: '2026-10-22T00:00:00.000Z',
          revision: 1,
          replayed: false,
        });
      if (path.endsWith('/context')) return jsonFixture(context);
      if (path.endsWith('/document')) {
        if (replaceOnDocument) membership = id(901);
        return jsonFixture({
          exposureId: id(400),
          assetId: chosen.assetId,
          assetRevision: chosen.assetRevision,
          document: boundDocument,
          degradedEssential: [],
        });
      }
      if (path === '/v1/media/grants') {
        if (replaceOnDocument) membership = id(901);
        return jsonFixture({
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: chosen.assetId,
            revision: chosen.assetRevision,
            title: 'Kept CI fixture',
            summary: 'Fixture only',
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
          expiresAt: '2099-10-22T00:00:00.000Z',
        });
      }
      if (path.endsWith('/observations/batch'))
        return jsonFixture({ accepted: 0, duplicates: 0, rejected: 0, revision: 1 });
      throw new Error('Unexpected fixture path');
    },
  });
  const session = createEncounterSession(scope, () => id(++next));
  return {
    scope,
    session,
    chosen,
    calls,
    snapshot,
    setMembership: (value: string) => {
      membership = value;
    },
    replaceOnDocument: () => {
      replaceOnDocument = true;
    },
    gateRead: (gate: Promise<void>) => {
      readGate = gate;
    },
    setBlock: (value: string) => {
      block = value;
      position = { kind: 'scroll', blockId: block, offsetWithinBlock: 37.5 };
    },
  };
}
describe('explicit mounted Keep return and measured checkpoint', () => {
  it.each(['reel', 'scroll'] as const)(
    'restores exact %s only after membership recheck; detail/restore adds no observation or set',
    async (kind) => {
      const f = keptFixture(kind);
      try {
        f.session.setForeground(true);
        expect(f.session.openKept(f.chosen, 'resume', f.snapshot())).toBe(true);
        await waitFor(() => expect(f.session.getState().phase).toBe('active'));
        const e = f.session.getState().entry!;
        expect(e.keepOrigin).toBe(true);
        expect(e.started).toBe(false);
        if (kind === 'reel')
          expect(e.position).toEqual({ kind: 'reel', positionMs: 12345.5, playing: false, muted: false });
        else
          expect(e.position).toEqual({
            kind: 'scroll',
            value: {
              assetId: f.chosen.assetId,
              revision: f.chosen.assetRevision,
              blockId: scrollDocument.sections[0]!.blocks[0]!.id,
              offsetWithinBlock: 37.5,
            },
          });
        expect(f.calls.filter((c) => c.path.endsWith('/keep/read')).length).toBeGreaterThanOrEqual(2);
        expect(f.calls.filter((c) => c.path.endsWith('/keep/place') || c.path.includes('/observations/'))).toHaveLength(
          0,
        );
      } finally {
        f.scope.end();
      }
    },
  );
  it('blocks a replaced membership after activation before recorder start; explicit top reuses exact Work IDs', async () => {
    const f = keptFixture();
    const expected = f.snapshot();
    f.replaceOnDocument();
    try {
      f.session.setForeground(true);
      f.session.openKept(f.chosen, 'resume', expected);
      await waitFor(() => expect(f.session.getState().phase).toBe('keep_blocked'));
      expect(f.session.getState().entry).toBeUndefined();
      expect(f.calls.filter((c) => c.path.includes('/observations/'))).toHaveLength(0);
      f.session.startKeepFromTop();
      await waitFor(() => expect(f.session.getState().phase).toBe('active'));
      expect(f.session.getState().entry?.position).toEqual({
        kind: 'reel',
        positionMs: 0,
        playing: false,
        muted: false,
      });
      expect(f.calls.filter((c) => c.path.endsWith('/open'))).toHaveLength(1);
      expect(f.calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(1);
      expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(0);
    } finally {
      f.scope.end();
    }
  });
  it('writes only a deliberately captured actual surface, keeps fractions, and requires a new read after ACK', async () => {
    const f = keptFixture();
    try {
      f.session.setForeground(true);
      f.session.openKept(f.chosen, 'top');
      await waitFor(() => expect(f.session.getState().phase).toBe('active'));
      await f.session.keepThisPlace();
      expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(0);
      const entry = f.session.getState().entry!;
      f.session.bindSurface(entry, {
        capture: () => ({ kind: 'reel', positionMs: 31.25, playing: false, muted: false }),
        pause: jest.fn(),
      });
      await f.session.keepThisPlace();
      await waitFor(() => expect(f.session.getState().keepPlace?.write).toBe('idle'));
      const writes = f.calls.filter((c) => c.path.endsWith('/keep/place'));
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body.position).toEqual({ kind: 'reel', positionMs: 31.25 });
      expect((writes[0]!.body.entry as { savedEntryId: string }).savedEntryId).toBe(f.snapshot().entry.savedEntryId);
      expect(f.calls.at(-1)?.path).toMatch(/keep\/read$/);
      f.session.park(entry);
      f.session.setForeground(false);
      expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(1);
    } finally {
      f.scope.end();
    }
  });
  it('discards a late abort-ignoring restore read when the account scope ends', async () => {
    const f = keptFixture();
    let release!: () => void;
    f.gateRead(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.session.setForeground(true);
    f.session.openKept(f.chosen, 'resume', f.snapshot());
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/keep/read'))).toBe(true));
    f.scope.end();
    release();
    await waitFor(() => expect(f.session.getState().phase).toBe('revoked'));
    expect(f.session.getState().entry).toBeUndefined();
    expect(f.calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(0);
  });
});

/** Two distinct authored Reel targets over the real Keep session. No backend/decoded media. */
function historyKeepFixture() {
  let next = 6000;
  let selected = 0;
  let gate: { target: number; promise: Promise<void> } | undefined;
  const revisions = [1, 1];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const offers = [0, 1].map((n) => ({ ...offer(n), relation: { kind: 'return' as const } }));
  const snapshot = (n: number): AvailableKeep => ({
    version: 'keep-place.v1',
    scope: { accountId: id(3), privacyEpoch: 1 },
    target: { assetId: offers[n]!.assetId, assetRevision: 2 },
    status: 'available',
    entry: { assetId: offers[n]!.assetId, assetRevision: 2, savedEntryId: id(900 + n) },
    place: { status: 'set', placeRevision: revisions[n]!, position: { kind: 'reel', positionMs: 0 } },
  });
  const scope = createAccountScope({
    account: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'history@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
      calls.push({ path, body });
      if (path.endsWith('/keep/read')) {
        const n = offers.findIndex((v) => v.assetId === (body.target as { assetId: string }).assetId);
        const result = snapshot(n);
        // Deliberately ignores abort; the controller must discard this old target's response.
        if (gate?.target === n) await gate.promise;
        return jsonFixture(result);
      }
      if (path.endsWith('/keep/place')) {
        const b = body as unknown as SetKeepPlace;
        const n = offers.findIndex((v) => v.assetId === b.entry.assetId);
        revisions[n] = b.expectedPlaceRevision + 1;
        return jsonFixture({
          version: 'keep-place.v1',
          scope: snapshot(n).scope,
          commandId: b.commandId,
          recordedAt: '2026-10-22T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.place.set',
          entry: b.entry,
          basePlaceRevision: b.expectedPlaceRevision,
          acceptedPlaceRevision: revisions[n],
        });
      }
      if (path.endsWith('/open')) {
        selected = offers.findIndex((v) => v.assetId === (body.target as { assetId: string }).assetId);
        return jsonFixture({
          commandId: body.commandId,
          sessionId: id(1),
          intentRevision: 1,
          revision: 1,
          decisionId: id(2),
          replayed: false,
          status: 'ready',
          offer: offers[selected],
          bufferedOffers: [],
        });
      }
      if (path.endsWith('/activate'))
        return jsonFixture({
          commandId: body.commandId,
          sessionId: id(1),
          intentRevision: 1,
          offerId: offers[selected]!.offerId,
          exposureId: id(400 + selected),
          assetId: offers[selected]!.assetId,
          assetRevision: 2,
          kind: 'reel',
          activatedAt: '2026-10-22T00:00:00.000Z',
          revision: 1,
          replayed: false,
        });
      if (path.endsWith('/context')) {
        const n = Number(path.split('/').at(-2)!.slice(-12)) - 400;
        return jsonFixture({
          exposureId: id(400 + n),
          assetId: offers[n]!.assetId,
          assetRevision: 2,
          revision: 1,
          session: { sessionId: id(1), intentRevision: 1 },
          actions: { saved: true, liked: false, hidden: false },
          variants: [],
          continuations: {
            seriesNext: { status: 'unavailable', reason: 'series_boundary' },
            seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
            related: { status: 'unavailable', reason: 'no_related_ready' },
          },
        });
      }
      if (path === '/v1/media/grants')
        return jsonFixture({
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: offers[selected]!.assetId,
            revision: 2,
            title: 'History fixture',
            summary: 'Authored fixture only',
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
          expiresAt: '2099-10-22T00:00:00.000Z',
        });
      throw new Error('Unexpected history fixture path');
    },
  });
  const session = createEncounterSession(scope, () => id(++next));
  const open = async (n: number) => {
    expect(session.openKept(offers[n]!, 'top')).toBe(true);
    await waitFor(() => expect(session.getState().phase).toBe('active'));
    return session.getState().entry!;
  };
  return {
    scope,
    session,
    calls,
    offers,
    open,
    gateRead: (target: number, promise: Promise<void>) => {
      gate = { target, promise };
    },
  };
}
describe('checkpoint ownership across retained history transitions', () => {
  it.each(['back', 'restore'] as const)('%s releases B before A can capture a Reel position', async (mode) => {
    const f = historyKeepFixture();
    try {
      f.session.setForeground(true);
      const a = await f.open(0);
      const b = await f.open(1);
      f.session.bindSurface(b, {
        capture: () => ({ kind: 'reel', positionMs: 222.5, playing: false, muted: false }),
        pause: jest.fn(),
      });
      await f.session.keepThisPlace();
      await waitFor(() => expect(f.session.getState().keepPlace?.write).toBe('idle'));
      if (mode === 'back') expect(f.session.back()).toBe(true);
      else f.session.restore(a.exposureId);
      expect(f.session.getState().entry).toBe(a);
      expect(f.session.getState().keepPlace).toBeUndefined();
      // Old renderer cleanup occurs after history already selected A.
      f.session.park(b);
      f.session.bindSurface(a, {
        capture: () => ({ kind: 'reel', positionMs: 111.25, playing: false, muted: false }),
        pause: jest.fn(),
      });
      await f.session.keepThisPlace();
      await waitFor(() => expect(f.session.getState().keepPlace?.write).toBe('idle'));
      const writes = f.calls.filter((v) => v.path.endsWith('/keep/place')).map((v) => v.body);
      expect(writes).toHaveLength(2);
      expect(writes.map((v) => v.entry)).toEqual([
        { assetId: f.offers[1]!.assetId, assetRevision: 2, savedEntryId: id(901) },
        { assetId: f.offers[0]!.assetId, assetRevision: 2, savedEntryId: id(900) },
      ]);
      expect(writes.map((v) => v.position)).toEqual([
        { kind: 'reel', positionMs: 222.5 },
        { kind: 'reel', positionMs: 111.25 },
      ]);
    } finally {
      f.scope.end();
    }
  });
  it.each(['back', 'restore'] as const)(
    '%s fences an abort-ignoring pending B read and never writes its capture',
    async (mode) => {
      const f = historyKeepFixture();
      let release!: () => void;
      let pending: Promise<void> | undefined;
      try {
        f.session.setForeground(true);
        const a = await f.open(0);
        const b = await f.open(1);
        f.gateRead(
          1,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        f.session.bindSurface(b, {
          capture: () => ({ kind: 'reel', positionMs: 222.5, playing: false, muted: false }),
          pause: jest.fn(),
        });
        pending = f.session.keepThisPlace();
        await waitFor(() =>
          expect(
            f.calls.some(
              (v) =>
                v.path.endsWith('/keep/read') && (v.body.target as { assetId: string }).assetId === b.offer.assetId,
            ),
          ).toBe(true),
        );
        if (mode === 'back') expect(f.session.back()).toBe(true);
        else f.session.restore(a.exposureId);
        expect(f.session.getState().entry).toBe(a);
        expect(f.session.getState().keepPlace).toBeUndefined();
        expect(f.session.retryKeep()).toBe(false);
        f.session.park(b);
        f.session.bindSurface(a, {
          capture: () => ({ kind: 'reel', positionMs: 111.25, playing: false, muted: false }),
          pause: jest.fn(),
        });
        await f.session.keepThisPlace();
        release();
        await waitFor(() => expect(f.session.getState().keepPlace?.write).toBe('idle'));
        const writes = f.calls.filter((v) => v.path.endsWith('/keep/place')).map((v) => v.body);
        expect(writes).toHaveLength(1);
        expect(writes[0]!.entry).toEqual({ assetId: a.offer.assetId, assetRevision: 2, savedEntryId: id(900) });
        expect(writes[0]!.position).toEqual({ kind: 'reel', positionMs: 111.25 });
        expect(f.session.getState().keepPlace?.snapshot?.target.assetId).toBe(a.offer.assetId);
      } finally {
        release?.();
        f.scope.end();
        await pending;
      }
    },
  );
});
