import { waitFor } from '@testing-library/react-native';
import { scopeOutbox } from '@knowscroll/client-core';
import type { OpenExposureRequest } from '@knowscroll/contracts';
import type { EncounterSession } from './encounter-session';
import { harness, offer } from './encounter-session.fixture';

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
      expect(JSON.stringify(input)).not.toMatch(/positionMs|blockId|offsetWithinBlock/);
    } finally {
      h.scope.end();
    }
  });
});
