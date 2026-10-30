import { waitFor } from '@testing-library/react-native';
import { CancelledError } from '@tanstack/react-query';
import {
  scopeOutbox,
  createAccountScope,
  createApiClient,
  memoryStore,
  type AccountScope,
  type AvailableRegionPreview,
} from '@knowscroll/client-core';
import { problemDetails, type RegionEncounterOpenRequest } from '@knowscroll/contracts';
import { ENCOUNTER_CAPABILITIES } from './capabilities';
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
        // Back restores a Reel paused, whatever it was doing when it was left.
        playing: false,
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

  it('Somewhere new stops at the offers, activates nothing until one is picked, then opens that one (E08)', async () => {
    const h = harness();
    try {
      await ready(h);
      h.setOutcome('exhausted');
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'exhausted');
      h.setOutcome('ready');
      h.setBuffered(2);
      expect(h.session.chooseDirection()).toBe(true);
      await waitForPhase(h.session, 'ready_offer');
      const choices = h.session.getState().choices!;
      expect(choices).toHaveLength(3);
      expect(commands(h, '/activate')).toHaveLength(1);
      expect(h.session.canBack()).toBe(true);
      h.session.pickDirection(choices[2]!.offerId);
      await waitForPhase(h.session, 'active');
      expect(commands(h, '/activate')).toHaveLength(2);
      expect((commands(h, '/activate')[1]!.body.target as { offerId: string }).offerId).toBe(choices[2]!.offerId);
      expect(h.session.getState().choices).toBeUndefined();
      expect(h.session.getState().entry!.offer.offerId).toBe(choices[2]!.offerId);
    } finally {
      h.scope.end();
    }
  });

  it('leaving the picker returns to the ending and activates nothing', async () => {
    const h = harness();
    try {
      await ready(h);
      h.setOutcome('exhausted');
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'exhausted');
      h.setOutcome('ready');
      h.setBuffered(1);
      h.session.chooseDirection();
      await waitForPhase(h.session, 'ready_offer');
      expect(h.session.back()).toBe(true);
      const state = h.session.getState();
      expect(state.phase).toBe('exhausted');
      expect(state.choices).toBeUndefined();
      expect(commands(h, '/activate')).toHaveLength(1);
    } finally {
      h.scope.end();
    }
  });

  it('with a single offer Somewhere new opens it at once', async () => {
    const h = harness();
    try {
      await ready(h);
      h.setOutcome('exhausted');
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'exhausted');
      h.setOutcome('ready');
      h.session.chooseDirection();
      await waitForPhase(h.session, 'active');
      expect(h.session.getState().choices).toBeUndefined();
      expect(commands(h, '/activate')).toHaveLength(2);
    } finally {
      h.scope.end();
    }
  });

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
      // Save stays unconfirmed until the originating command acknowledges, even after Back.
      expect(origin.context.actions.saved).toBe(false);
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
      expect(commands(h, '/navigate')[0]!.body.intent).toEqual({
        mode: 'vertical',
        direction: 'previous',
        format: 'reel',
      });
      expect(commands(h, '/activate')).toHaveLength(2);
      const count = commands(h, '/navigate').length;
      h.session.back();
      expect(commands(h, '/navigate')).toHaveLength(count);
    } finally {
      h.scope.end();
    }
  });

  it('a Reel that was playing under a sheet plays on when it closes, but a parked entry returns paused', async () => {
    const h = harness();
    try {
      await ready(h);
      const entry = h.session.getState().entry!;
      h.session.bindSurface(entry, {
        capture: () => ({ kind: 'reel', positionMs: 5000, playing: true, muted: false }),
        pause: jest.fn(),
      });
      h.session.setOverlay(true);
      expect(entry.resumePlaying).toBeFalsy();
      h.session.setOverlay(false);
      expect(entry.resumePlaying).toBe(true);
      // Leaving (a tab detour, Back, another subject) is not a sheet closing.
      h.session.bindSurface(entry, { capture: () => undefined, pause: jest.fn() });
      h.session.park(entry);
      expect(entry.resumePlaying).toBe(false);
    } finally {
      h.scope.end();
    }
  });

  it('Back restores a Reel paused, so closing a sheet afterwards never starts it with sound', async () => {
    const h = harness();
    try {
      await ready(h);
      const first = h.session.getState().entry!;
      h.session.bindSurface(first, {
        capture: () => ({ kind: 'reel', positionMs: 5000, playing: true, muted: false }),
        pause: jest.fn(),
      });
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      expect(first.position).toMatchObject({ playing: true });
      expect(h.session.back()).toBe(true);
      expect(h.session.getState().entry).toBe(first);
      expect(first.position).toMatchObject({ positionMs: 5000, playing: false });
      h.session.setOverlay(true);
      h.session.setOverlay(false);
      expect(first.resumePlaying).toBeFalsy();
    } finally {
      h.scope.end();
    }
  });

  it('returning from another tab restores a Reel paused, so a sheet closed before its source restores never plays it', async () => {
    const h = harness();
    try {
      await ready(h);
      const first = h.session.getState().entry!;
      h.session.bindSurface(first, {
        capture: () => ({ kind: 'reel', positionMs: 7000, playing: true, muted: false }),
        pause: jest.fn(),
      });
      h.session.setForeground(false);
      expect(first.position).toMatchObject({ positionMs: 7000, playing: true });
      h.session.setForeground(true);
      expect(first.position).toMatchObject({ positionMs: 7000, playing: false });
      h.session.setOverlay(true);
      h.session.setOverlay(false);
      expect(first.resumePlaying).toBeFalsy();
    } finally {
      h.scope.end();
    }
  });

  it('a trail jump restores the earlier Reel paused, so a sheet closed afterwards never plays it', async () => {
    const h = harness();
    try {
      await ready(h);
      const first = h.session.getState().entry!;
      h.session.bindSurface(first, {
        capture: () => ({ kind: 'reel', positionMs: 3000, playing: true, muted: false }),
        pause: jest.fn(),
      });
      h.session.navigate({ mode: 'vertical', direction: 'next' });
      await waitForPhase(h.session, 'active');
      const second = h.session.getState().entry!;
      expect(second).not.toBe(first);
      h.session.restore(first.exposureId);
      expect(h.session.getState().entry).toBe(first);
      expect(first.position).toMatchObject({ positionMs: 3000, playing: false });
      h.session.setOverlay(true);
      h.session.setOverlay(false);
      expect(first.resumePlaying).toBeFalsy();
    } finally {
      h.scope.end();
    }
  });

  it('a context refetch that a newer one replaced is not "offline"', async () => {
    const h = harness();
    try {
      await ready(h);
      const exposureId = h.session.getState().entry!.exposureId;
      h.session.contextFailure(exposureId, new CancelledError());
      expect(h.session.getState().phase).toBe('active');
      h.session.contextFailure(exposureId, new TypeError('Failed to fetch'));
      expect(h.session.getState().phase).toBe('offline');
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

describe('Not interested from the encounter (P03, D-055)', () => {
  it('saves first, closes the sheet, moves on, and Undo returns to the subject left behind', async () => {
    const h = harness();
    try {
      const first = await ready(h);
      h.session.setOverlay(true);
      await expect(h.session.notInterested()).resolves.toBe(true);
      expect(h.session.getState().overlay).toBe(false);
      expect(commands(h, '/not-interested')).toHaveLength(1);
      expect(commands(h, '/not-interested')[0]!.body).toMatchObject({ assetId: first.offer.assetId });
      await waitFor(() => expect(commands(h, '/navigate')).toHaveLength(1));
      expect(commands(h, '/navigate')[0]!.body.intent).toEqual({ mode: 'vertical', direction: 'next', format: 'reel' });
      await waitFor(() => expect(h.session.getState().entry?.exposureId).not.toBe(first.exposureId));
      expect(h.session.feedback.getState().notInterested).toMatchObject({ status: 'acknowledged' });

      await expect(h.session.undoNotInterested()).resolves.toBe(true);
      expect(commands(h, '/not-interested/undo')).toHaveLength(1);
      expect(commands(h, '/not-interested/undo')[0]!.body).toMatchObject({ assetId: first.offer.assetId });
      expect(h.session.getState().entry?.exposureId).toBe(first.exposureId);
      // Taking it back is not a new encounter: nothing was activated again.
      expect(commands(h, '/activate')).toHaveLength(2);
    } finally {
      h.scope.end();
    }
  });

  it('moves nothing and keeps the sheet open when the save is not confirmed, and Retry repeats the same command', async () => {
    const h = harness();
    try {
      const first = await ready(h);
      h.setFeedbackFailure(true);
      h.session.setOverlay(true);
      await expect(h.session.notInterested()).resolves.toBe(false);
      expect(h.session.getState().overlay).toBe(true);
      expect(h.session.getState().entry?.exposureId).toBe(first.exposureId);
      expect(commands(h, '/navigate')).toHaveLength(0);
      expect(h.session.feedback.getState().notInterested).toMatchObject({ status: 'failed', step: 'mark' });

      h.setFeedbackFailure(false);
      await expect(h.session.retryNotInterested()).resolves.toBe(true);
      const sent = commands(h, '/not-interested');
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body.commandId).toBe(sent[0]!.body.commandId);
      expect(h.session.getState().overlay).toBe(false);
      await waitFor(() => expect(commands(h, '/navigate')).toHaveLength(1));
    } finally {
      h.scope.end();
    }
  });

  it('opens the report menu as its own overlay owner and a form directly from the ⋯ menu', async () => {
    const h = harness();
    try {
      await ready(h);
      h.session.openFeedback();
      expect(h.session.getState()).toMatchObject({ overlay: true, overlayOwner: 'feedback', feedbackStart: 'menu' });
      h.session.setOverlay(false);
      h.session.openFeedback('abuse');
      expect(h.session.getState()).toMatchObject({ overlay: true, overlayOwner: 'feedback', feedbackStart: 'abuse' });
      h.session.setOverlay(false);
      expect(h.session.getState()).toMatchObject({ overlay: false, overlayOwner: undefined, feedbackStart: undefined });
      // Opening the menu or a form sends nothing: only Send does.
      expect(h.calls.filter((call) => call.path.startsWith('/v1/feedback'))).toHaveLength(0);
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
  let unavailableSaved: { assetId: string; assetRevision: number } | undefined;
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
                revision: 0,
                policy: { on: true, generation: 1 },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          });
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
        return jsonFixture(
          unavailableSaved
            ? {
                version: 'keep-place.v1',
                scope: snapshot().scope,
                target: unavailableSaved,
                status: 'saved_unavailable',
                entry: { ...unavailableSaved, savedEntryId: membership },
              }
            : snapshot(),
        );
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
    unavailableSaved: (value: { assetId: string; assetRevision: number }) => {
      unavailableSaved = { assetId: value.assetId, assetRevision: value.assetRevision };
    },
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
  it('blocks a replaced membership after activation and top cannot bypass the displayed membership', async () => {
    const f = keptFixture();
    const expected = f.snapshot();
    f.replaceOnDocument();
    try {
      f.session.setForeground(true);
      f.session.openKept(f.chosen, 'resume', expected);
      await waitFor(() => expect(f.session.getState().phase).toBe('keep_blocked'));
      expect(f.session.getState().entry).toBeUndefined();
      expect(f.calls.filter((c) => c.path.includes('/observations/'))).toHaveLength(0);
      const readsBeforeTop = f.calls.filter((c) => c.path.endsWith('/keep/read')).length;
      f.session.startKeepFromTop();
      await waitFor(() =>
        expect(f.calls.filter((c) => c.path.endsWith('/keep/read')).length).toBeGreaterThan(readsBeforeTop),
      );
      await waitFor(() => expect(f.session.getState().phase).toBe('keep_blocked'));
      expect(f.session.getState().entry).toBeUndefined();
      expect(f.calls.filter((c) => c.path.endsWith('/open'))).toHaveLength(1);
      expect(f.calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(1);
      expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(0);
    } finally {
      f.scope.end();
    }
  });
  it.each(['resume', 'top'] as const)('refuses selected A→B before a %s return issues Open', async (mode) => {
    const f = keptFixture();
    const expected = f.snapshot();
    try {
      f.setMembership(id(901));
      f.session.setForeground(true);
      expect(f.session.openKept(f.chosen, mode, mode === 'resume' ? expected : undefined, expected.entry)).toBe(true);
      await waitFor(() => expect(f.session.getState().phase).toBe('keep_blocked'));
      expect(f.calls.every((c) => c.path.endsWith('/keep/read'))).toBe(true);
      expect(f.session.getState().entry).toBeUndefined();
    } finally {
      f.scope.end();
    }
  });
  it('explicit updated TOP verifies unavailable old A, opens the chosen new revision and inherits no place', async () => {
    const f = keptFixture();
    const old = { assetId: f.chosen.assetId, assetRevision: 1, savedEntryId: id(900) };
    f.unavailableSaved(old);
    try {
      f.session.setForeground(true);
      expect(f.session.openKept(f.chosen, 'top', undefined, old)).toBe(true);
      await waitFor(() => expect(f.session.getState().phase).toBe('active'));
      expect(f.calls.find((c) => c.path.endsWith('/open'))?.body.target).toEqual({
        kind: 'return',
        assetId: old.assetId,
        assetRevision: f.chosen.assetRevision,
      });
      expect(f.calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(1);
      expect(f.session.getState().entry?.position).toEqual({
        kind: 'reel',
        positionMs: 0,
        playing: false,
        muted: false,
      });
      expect(
        f.calls
          .filter((c) => c.path.endsWith('/keep/read'))
          .every((c) => JSON.stringify(c.body.target) === JSON.stringify({ assetId: old.assetId, assetRevision: 1 })),
      ).toBe(true);
      expect(f.calls.some((c) => c.path.endsWith('/keep/place') || c.path.includes('/observations/'))).toBe(false);
    } finally {
      f.scope.end();
    }
  });
  it('explicit updated TOP still refuses replacement B at the unavailable old ref before Open', async () => {
    const f = keptFixture();
    const old = { assetId: f.chosen.assetId, assetRevision: 1, savedEntryId: id(900) };
    f.unavailableSaved(old);
    f.setMembership(id(901));
    try {
      f.session.setForeground(true);
      expect(f.session.openKept(f.chosen, 'top', undefined, old)).toBe(true);
      await waitFor(() => expect(f.session.getState().phase).toBe('keep_blocked'));
      expect(f.calls.every((c) => c.path.endsWith('/keep/read'))).toBe(true);
      expect(f.session.getState().entry).toBeUndefined();
    } finally {
      f.scope.end();
    }
  });
  it('Explore removal binds the displayed authoritative A and refuses a fresh replacement B', async () => {
    const f = keptFixture();
    try {
      f.session.setForeground(true);
      f.session.openKept(f.chosen, 'top');
      await waitFor(() => expect(f.session.getState().phase).toBe('active'));
      f.session.bindSurface(f.session.getState().entry!, {
        capture: () => ({ kind: 'reel', positionMs: 0, playing: false, muted: false }),
        pause: jest.fn(),
      });
      await waitFor(() => expect(f.session.getState().keepPlace?.snapshot?.status).toBe('available'));
      expect(f.session.getState().keepPlace?.snapshot).toMatchObject({ entry: { savedEntryId: id(900) } });
      f.setMembership(id(901));
      f.session.act('unsave');
      await waitFor(() => expect(f.session.getState().removal?.status).toBe('unavailable'));
      expect(f.calls.some((c) => c.path.endsWith('/keep/remove') || c.path === '/v1/actions')).toBe(false);
      expect(f.session.getState().removal).toMatchObject({ item: { savedEntryId: id(900) } });
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
  it.each(['reel', 'scroll'] as const)(
    'automatically captures actual %s on background and never uploads restored state',
    async (kind) => {
      const f = keptFixture(kind);
      try {
        f.session.setForeground(true);
        f.session.openKept(f.chosen, 'top');
        await waitFor(() => expect(f.session.getState().phase).toBe('active'));
        const entry = f.session.getState().entry!;
        const capture =
          kind === 'reel'
            ? { kind: 'reel' as const, positionMs: 321.25, playing: false, muted: false }
            : {
                kind: 'scroll' as const,
                value: {
                  assetId: entry.offer.assetId,
                  revision: entry.offer.assetRevision,
                  blockId: scrollDocument.sections[0]!.blocks[0]!.id,
                  offsetWithinBlock: 63.5,
                },
              };
        f.session.bindSurface(entry, { capture: () => capture, pause: jest.fn() });
        await waitFor(() => expect(f.session.getState().keepPlace?.status).toBe('ready'));
        expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(0);
        f.session.setForeground(false);
        await waitFor(() => expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(1));
        const sent = f.calls.find((c) => c.path.endsWith('/keep/place'))!.body;
        expect(sent.entry).toEqual(f.snapshot().entry);
        expect(sent.position).toEqual(
          kind === 'reel'
            ? { kind, positionMs: 321.25 }
            : { kind, blockId: scrollDocument.sections[0]!.blocks[0]!.id, offsetWithinBlock: 63.5 },
        );
        await waitFor(() => expect(f.calls.at(-1)?.path).toMatch(/keep\/read$/));
        expect(f.session.getState().keepPlace).toBeUndefined();
        expect(f.calls.filter((c) => c.path.includes('/observations/'))).toHaveLength(0);
      } finally {
        f.scope.end();
      }
    },
  );

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
  const positions = [0, 0];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const offers = [0, 1].map((n) => ({ ...offer(n), relation: { kind: 'return' as const } }));
  const snapshot = (n: number): AvailableKeep => ({
    version: 'keep-place.v1',
    scope: { accountId: id(3), privacyEpoch: 1 },
    target: { assetId: offers[n]!.assetId, assetRevision: 2 },
    status: 'available',
    entry: { assetId: offers[n]!.assetId, assetRevision: 2, savedEntryId: id(900 + n) },
    place: { status: 'set', placeRevision: revisions[n]!, position: { kind: 'reel', positionMs: positions[n]! } },
  });
  const scope = createAccountScope({
    account: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'history@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
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
                revision: 0,
                policy: { on: true, generation: 1 },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          });
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
        if (b.position.kind === 'reel') positions[n] = b.position.positionMs;
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

function regionEncounter() {
  const h = harness(),
    calls: RegionEncounterOpenRequest[] = [];
  let failure: 'unknown' | 'authority' | undefined,
    wrong: 'asset' | 'target' | 'scope' | 'capabilities' | 'session' | undefined;
  const card: AvailableRegionPreview = {
    version: 'region-encounter-preview.v1',
    readId: id(700),
    target: { kind: 'region', regionId: id(701), expectedObjectRevision: 1, expectedGeographyRevision: 3 },
    scope: { universeId: h.scope.account.universeId, privacyEpoch: 1, personalWatermark: 0 },
    capabilities: ENCOUNTER_CAPABILITIES,
    recordedAt: '2026-10-22T00:00:00.000Z',
    geographyRevision: 3,
    status: 'available',
    encounter: { assetId: offer(0).assetId, assetRevision: 2, metadata: offer(0).metadata },
  };
  const regionApi = createApiClient({
    baseUrl: 'https://region.fixture.test',
    fetch: async (request) => {
      const input = (await request.json()) as RegionEncounterOpenRequest;
      calls.push(input);
      if (failure === 'unknown') throw new TypeError('CI unknown send');
      if (failure === 'authority')
        return new Response(JSON.stringify(problemDetails('UNAUTHENTICATED')), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        });
      return new Response(
        JSON.stringify({
          version: input.version,
          target: wrong === 'target' ? { ...input.target, regionId: id(999) } : input.target,
          expectedEncounter: input.expectedEncounter,
          capabilities:
            wrong === 'capabilities' ? { documentSchemas: ['scroll-document.v1'], blocks: {} } : input.capabilities,
          universeId: wrong === 'scope' ? id(999) : h.scope.account.universeId,
          privacyEpoch: 1,
          outcome: {
            commandId: input.commandId,
            sessionId: wrong === 'session' ? id(999) : id(1),
            intentRevision: 1,
            revision: 1,
            decisionId: offer(0).decisionId,
            replayed: false,
            status: 'ready',
            offer: wrong === 'asset' ? offer(1) : offer(0),
            bufferedOffers: [],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  // Region transport is authored here; all real activation/context/media/recording uses existing fixture transport.
  const experience = new Proxy(h.scope.api.experience, {
    get: (target, key) =>
      key === 'openRegionEncounter' ? regionApi.experience.openRegionEncounter : (Reflect.get(target, key) as unknown),
  });
  const scope: AccountScope = {
    ...h.scope,
    get active() {
      return h.scope.active;
    },
    api: new Proxy(h.scope.api, {
      get: (target, key) => (key === 'experience' ? experience : (Reflect.get(target, key) as unknown)),
    }),
  };
  let sequence = 800;
  return {
    ...h,
    session: createEncounterSession(scope, () => id(sequence++)),
    card,
    regionCalls: calls,
    fail: (value: typeof failure) => {
      failure = value;
    },
    wrong: (value: typeof wrong) => {
      wrong = value;
    },
  };
}
it('region Open enters the existing activation/recorder engine; map Back captures actual media place and makes no new encounter', async () => {
  const h = regionEncounter();
  let returned = 0;
  expect(
    h.session.openRegion(h.card, 'Deployment · Inference', () => {
      returned++;
    }),
  ).toBe(true);
  await waitFor(() => expect(h.session.getState().phase).toBe('ready_offer'));
  expect(commands(h, '/activate')).toHaveLength(0);
  h.session.setForeground(true);
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  const entry = h.session.getState().entry!;
  h.session.mount(entry);
  const pause = jest.fn();
  h.session.bindSurface(entry, {
    capture: () => ({ kind: 'reel', positionMs: 9876.125, playing: true, muted: false }),
    pause,
  });
  const suspend = jest.spyOn(entry.recorder, 'suspend');
  const before = h.calls.length;
  // U04: the encounter a region card opened says where it came from, until the person has gone back.
  expect(h.session.regionOriginOf(entry)).toBe('Deployment · Inference');
  expect(h.session.canBack()).toBe(true);
  expect(h.session.back()).toBe(true);
  expect(returned).toBe(1);
  expect(h.session.regionOriginOf(entry)).toBeUndefined();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(suspend).toHaveBeenCalledTimes(1);
  expect(entry.position).toEqual({ kind: 'reel', positionMs: 9876.125, playing: true, muted: false });
  expect(h.calls).toHaveLength(before);
  expect(h.session.getState().entry?.recorder).toBe(entry.recorder);
  expect(Object.keys(h.regionCalls[0]!).sort()).toEqual([
    'capabilities',
    'commandId',
    'expectedEncounter',
    'recordingGeneration',
    'target',
    'version',
  ]);
  expect(h.regionCalls[0]!.expectedEncounter).toEqual({ assetId: h.card.encounter.assetId, assetRevision: 2 });
  h.scope.end();
  expect(h.session.back()).toBe(false);
  expect(h.session.getState().entry).toBeUndefined();
});
it('unknown region command retains exact A through an auth refusal, never auto-retries on focus and never adopts displayed B', async () => {
  const h = regionEncounter();
  h.fail('unknown');
  h.session.openRegion(h.card, 'Deployment · Inference', () => undefined);
  await waitFor(() => expect(h.session.getState().phase).toBe('offline'));
  h.session.setForeground(true);
  await Promise.resolve();
  expect(h.regionCalls).toHaveLength(1);
  h.fail('authority');
  h.session.retry();
  await waitFor(() => expect(h.session.getState().phase).toBe('error'));
  expect(h.regionCalls).toHaveLength(2);
  expect(h.regionCalls[1]).toEqual(h.regionCalls[0]);
  expect(
    h.session.openRegion(
      { ...h.card, encounter: { ...h.card.encounter, assetId: offer(1).assetId } },
      'Deployment · Inference',
      () => undefined,
    ),
  ).toBe(false);
  h.fail(undefined);
  h.session.retry();
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  expect(h.regionCalls).toHaveLength(3);
  expect(h.regionCalls[2]).toEqual(h.regionCalls[0]);
  expect(h.session.getState().entry?.offer.assetId).toBe(h.card.encounter.assetId);
  expect(commands(h, '/activate')).toHaveLength(1);
  h.scope.end();
});
it.each(['asset', 'target', 'scope', 'capabilities'] as const)(
  'refuses a structurally plausible wrong region %s response before activation',
  async (wrong) => {
    const h = regionEncounter();
    h.wrong(wrong);
    h.session.setForeground(true);
    h.session.openRegion(h.card, 'Deployment · Inference', () => undefined);
    await waitFor(() => expect(h.session.getState().phase).toBe('offline'));
    expect(commands(h, '/activate')).toHaveLength(0);
    expect(h.session.getState().entry).toBeUndefined();
    h.session.retry();
    await waitFor(() => expect(h.regionCalls).toHaveLength(2));
    expect(h.regionCalls[1]).toEqual(h.regionCalls[0]);
    h.scope.end();
  },
);
it('binds an existing region intent to the supplied session and retains its exact command on retry', async () => {
  const h = regionEncounter();
  try {
    await ready(h);
    const previous = h.session.getState().entry!;
    const activations = commands(h, '/activate').length;
    h.wrong('session');
    expect(h.session.openRegion(h.card, 'Deployment · Inference', () => undefined)).toBe(true);
    await waitFor(() => expect(h.session.getState().phase).toBe('offline'));
    expect(h.regionCalls[0]!.session).toEqual({ sessionId: id(1), expectedIntentRevision: 1 });
    expect(commands(h, '/activate')).toHaveLength(activations);
    expect(h.session.getState().entry).toBe(previous);
    h.session.retry();
    await waitFor(() => expect(h.regionCalls).toHaveLength(2));
    expect(h.regionCalls[1]).toEqual(h.regionCalls[0]);
    expect(commands(h, '/activate')).toHaveLength(activations);
    await waitFor(() => expect(h.session.getState().phase).toBe('offline'));
    h.wrong(undefined);
    h.session.retry();
    await waitFor(() => expect(h.session.getState().phase).toBe('active'));
    expect(h.regionCalls[2]).toEqual(h.regionCalls[0]);
    expect(commands(h, '/activate')).toHaveLength(activations + 1);
    expect(h.session.getState().entry?.sessionId).toBe(id(1));
  } finally {
    h.scope.end();
  }
});
it('still returns to the map after the original region entry is evicted from bounded encounter history', async () => {
  const h = regionEncounter();
  let returned = 0;
  h.session.setForeground(true);
  h.session.openRegion(h.card, 'Deployment · Inference', () => {
    returned++;
  });
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  const original = h.session.getState().entry!;
  for (let n = 0; n < 21; n++) {
    h.session.navigate({ mode: 'vertical', direction: 'next' });
    await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  }
  expect(original.disposed).toBe(true);
  expect(h.session.getState().trail).toHaveLength(20);
  const before = h.calls.length;
  for (let n = 0; n < 20; n++) expect(h.session.back()).toBe(true);
  expect(returned).toBe(1);
  expect(h.session.canBack()).toBe(false);
  expect(h.calls).toHaveLength(before);
  h.scope.end();
});

it('retains original producer/activation/action bodies and leaves an old offer playback-only after Resume (CI fixture)', async () => {
  const h = harness();
  try {
    h.session.open({ kind: 'discover' });
    await waitFor(() => expect(h.session.getState().phase).toBe('ready_offer'));
    expect(commands(h, '/open')[0]?.body.recordingGeneration).toBe(1);
    h.setRecordingGeneration(3);
    await h.scope.recording!.refresh();
    h.session.setForeground(true);
    await waitFor(() => expect(h.session.getState().phase).toBe('active'));
    const old = h.session.getState().entry!;
    expect(commands(h, '/activate')[0]?.body.recordingGeneration).toBe(3);
    if (old.kind !== 'reel') throw new Error('fixture Reel expected');
    old.recorder.sample({
      positionMs: 0,
      monotonicMs: performance.now(),
      playing: true,
      visible: true,
      buffering: false,
    });
    old.recorder.sample({
      positionMs: 500,
      monotonicMs: performance.now() + 500,
      playing: true,
      visible: true,
      buffering: false,
    });
    old.recorder.flush();
    expect(h.batches).toEqual([]);
    h.session.navigate({ mode: 'vertical', direction: 'next' });
    await waitFor(() => expect(commands(h, '/activate')).toHaveLength(2));
    await waitFor(() => expect(h.session.getState().phase).toBe('active'));
    const fresh = h.session.getState().entry!;
    expect(commands(h, '/navigate')[0]?.body.recordingGeneration).toBe(3);
    expect(fresh.recorder.sessionId).toBe(commands(h, '/activate')[1]?.body.commandId);
    h.setRecordingGeneration(4);
    await h.scope.recording!.refresh();
    h.setActionFailure(true);
    h.session.act('save');
    await waitFor(() => expect(h.session.getState().actionFailed).toBe(true));
    h.setRecordingGeneration(5);
    await h.scope.recording!.refresh();
    h.setActionFailure(false);
    h.session.retryAction();
    await waitFor(() => expect(h.session.getState().actionFailed).toBe(false));
    const saves = commands(h, '/actions');
    expect(saves[0]?.body.recordingGeneration).toBe(4);
    expect(saves[1]?.body).toEqual(saves[0]?.body);
    expect(
      h.session.open({ kind: 'return', assetId: fresh.offer.assetId, assetRevision: fresh.offer.assetRevision }),
    ).toBe(true);
    await waitFor(() => expect(commands(h, '/open')).toHaveLength(2));
    expect(commands(h, '/open')[1]?.body.recordingGeneration).toBe(5);
  } finally {
    h.scope.end();
  }
});

describe('A move to a new subject names the format the person is in (D-132)', () => {
  it('sends scroll from a Scroll, so Next stays a Scroll while one is left', async () => {
    const f = keptFixture('scroll');
    try {
      f.session.setForeground(true);
      f.session.open({ kind: 'discover' });
      await waitFor(() => expect(f.session.getState().phase).toBe('active'));
      f.session.gesture('subjectNext');
      // The fixture has no navigate endpoint; the request it records is what this test is about.
      await waitFor(() => expect(f.calls.some((call) => call.path.endsWith('/navigate'))).toBe(true));
      expect(f.calls.find((call) => call.path.endsWith('/navigate'))!.body.intent).toEqual({
        mode: 'vertical',
        direction: 'next',
        format: 'scroll',
      });
    } finally {
      f.scope.end();
    }
  });
});
