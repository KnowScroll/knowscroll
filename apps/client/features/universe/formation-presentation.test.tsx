import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { FormationPresentation } from './formation-presentation';
import { createUniverseViewSession } from './universe-session';
import { fixtureAccount, fixtureId as id, sceneFixture } from './universe.fixture';
// Native UUID stub is replaced only in these authored HTTP/component fixtures.
jest.mock('../../platform/command-id', () => {
  let n = 40000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(n++).toString(16).padStart(12, '0')}` };
});
const scopes: AccountScope[] = [];
afterEach(() => scopes.splice(0).forEach((s) => s.end()));
function fixture(reducedMotion = true, available = true) {
  const world = sceneFixture(),
    recordedAt = new Date().toISOString();
  const calls: { path: string; body: Record<string, unknown>; at: number }[] = [];
  let next = 1000,
    failClaim = false;
  let sceneGate: Promise<void> | undefined;
  const fact = {
    transitionId: id(9000),
    recordedAt,
    geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
    targets: [
      {
        objectId: id(12),
        parentId: id(10),
        kind: 'planet',
        objectRevision: 1,
        label: 'CI planet 2',
        truthStatus: 'factual',
      },
    ],
    sequence: { kind: 'planet', planetId: id(12), durationMs: 2400 },
  };
  let watermark = 40;
  const scope = createAccountScope({
    account: fixtureAccount,
    store: memoryStore(),
    authorization: () => undefined,
    baseUrl: 'https://formation-ui.fixture.test',
    fetch: async (request) => {
      const path = new URL(request.url).pathname,
        body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body, at: performance.now() });
      let value: unknown;
      if (path.endsWith('/formation/read'))
        value = {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: watermark },
          recordedAt: new Date().toISOString(),
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          ...(available
            ? {
                status: 'available',
                fact,
                eligibility: { status: 'claimable', until: new Date(Date.parse(recordedAt) + 300000).toISOString() },
              }
            : { status: 'unavailable', reason: 'temporarily_unavailable' }),
        };
      else if (path.endsWith('/formation/claim')) {
        if (failClaim) throw new TypeError('Authored lost claim acknowledgement');
        const claimedAt = new Date().toISOString(),
          expiresAt = new Date(Date.parse(claimedAt) + 30000).toISOString();
        value = {
          version: body.version,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: (watermark = 41) },
          receipt: {
            commandId: body.commandId,
            transitionId: body.transitionId,
            attemptNonce: body.attemptNonce,
            recordedAt: claimedAt,
            outcome: 'claimed',
            claim: { claimId: id(950), claimedAt, expiresAt },
          },
          replayed: false,
          current: { status: 'active', observedAt: claimedAt, claimId: id(950), expiresAt },
        };
      } else if (path.endsWith('/formation/acknowledge'))
        value = {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: (watermark = 42) },
          recordedAt: new Date().toISOString(),
          replayed: false,
          requestedDisposition: body.disposition,
          outcome: 'recorded',
        };
      else {
        await sceneGate;
        const reply = world.reply(path, body) as Record<string, unknown>;
        value = {
          ...reply,
          ...('personalWatermark' in reply ? { personalWatermark: watermark } : {}),
          ...(reply.scope
            ? { scope: { ...(reply.scope as Record<string, unknown>), personalWatermark: watermark } }
            : {}),
        };
      }
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    },
  });
  scopes.push(scope);
  const session = createUniverseViewSession(scope, () => id(next++));
  session.configure({ detail: 'full', reducedMotion });
  return {
    scope,
    session,
    calls,
    failClaim: (value: boolean) => {
      failClaim = value;
    },
    gateScene: (value: Promise<void>) => {
      sceneGate = value;
    },
  };
}
const pathCalls = (h: ReturnType<typeof fixture>, suffix: string) => h.calls.filter((c) => c.path.endsWith(suffix));
it('claims before mounting a reduced-motion final still and caption, then shown and Done focus the actual target without encounter evidence', async () => {
  const h = fixture();
  h.session.setForeground(true);
  await waitFor(() => expect(h.session.formation.getState().status).toBe('ready'));
  expect(pathCalls(h, '/claim')).toHaveLength(1);
  expect(pathCalls(h, '/acknowledge')).toHaveLength(0);
  const v = await render(<FormationPresentation session={h.session} />);
  await waitFor(() => expect(screen.getByText('A new place: CI planet 2')).toBeOnTheScreen());
  await waitFor(() => expect(h.session.formation.getState().status).toBe('final'));
  expect(pathCalls(h, '/acknowledge')[0]!.body).toMatchObject({
    transitionId: id(9000),
    claimId: id(950),
    disposition: 'shown',
    attemptNonce: pathCalls(h, '/claim')[0]!.body.attemptNonce,
  });
  const backStates: boolean[] = [];
  const off = h.session.subscribe(() => backStates.push(h.session.canBack()));
  expect(h.session.canBack()).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  off();
  // The real web history subscriber must never see an intermediate false and queue a
  // history.back between story dismissal and the canonical camera/focus commit.
  expect(backStates.length).toBeGreaterThan(0);
  expect(backStates.every(Boolean)).toBe(true);
  expect(h.session.getState().focusId).toBe(id(12));
  expect(h.session.getState().historyDepth).toBe(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(h.calls.every((c) => c.path.startsWith('/v1/universe/') || c.path === '/v1/rooms/stations')).toBe(true);
  await v.unmount();
});
it('full presentation survives its own root-hint refresh of the same validated scene and sends shown only after actual2400ms mounted duration', async () => {
  const h = fixture(false);
  h.session.setForeground(true);
  await waitFor(() => expect(h.session.formation.getState().status).toBe('ready'));
  const v = await render(<FormationPresentation session={h.session} />);
  expect(screen.getByRole('button', { name: 'Skip' })).toBeOnTheScreen();
  expect(pathCalls(h, '/acknowledge')).toHaveLength(0);
  let release!: () => void;
  h.gateScene(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  // The normal AccountScope query invalidation models a disposable own-claim hint. Its
  // pending current read keeps exactly the already-validated frozen snapshot pair.
  const refresh = h.scope.queryClient.invalidateQueries({ queryKey: h.scope.queryKey() });
  await waitFor(() => expect(h.session.getState().read.status).toBe('loading'));
  expect(h.session.formation.getState().status).toBe('presenting');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeOnTheScreen(), { timeout: 4500 });
  const ack = pathCalls(h, '/acknowledge')[0]!;
  expect(ack.at - pathCalls(h, '/claim')[0]!.at).toBeGreaterThanOrEqual(2400);
  expect(ack.body.disposition).toBe('shown');
  await act(async () => {
    release();
    await refresh;
  });
  expect(h.session.getState().read.status).toBe('ready');
  expect(screen.getByText('A new place: CI planet 2')).toBeOnTheScreen();
  await v.unmount();
}, 10000);
it('leaving an unfinished mounted sequence sends skipped once; remount cannot start it again', async () => {
  const h = fixture(false);
  h.session.setForeground(true);
  await waitFor(() => expect(h.session.formation.getState().status).toBe('ready'));
  const first = await render(<FormationPresentation session={h.session} />);
  expect(screen.getByRole('button', { name: 'Skip' })).toBeOnTheScreen();
  await first.unmount();
  await waitFor(() => expect(h.session.formation.getState().status).toBe('final'));
  expect(pathCalls(h, '/acknowledge')).toHaveLength(1);
  expect(pathCalls(h, '/acknowledge')[0]!.body.disposition).toBe('skipped');
  const second = await render(<FormationPresentation session={h.session} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(pathCalls(h, '/claim')).toHaveLength(1);
  await second.unmount();
});
it('unknown claim has no story or optimistic shown; explicit retry sends the original command and nonce', async () => {
  const h = fixture();
  h.failClaim(true);
  h.session.setForeground(true);
  await waitFor(() => expect(h.session.formation.getState().status).toBe('claim_unknown'));
  const v = await render(<FormationPresentation session={h.session} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(pathCalls(h, '/acknowledge')).toHaveLength(0);
  h.failClaim(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Retry map view' }));
  await waitFor(() => expect(h.session.formation.getState().status).toBe('final'));
  expect(pathCalls(h, '/claim')[1]!.body).toEqual(pathCalls(h, '/claim')[0]!.body);
  expect(pathCalls(h, '/acknowledge')[0]!.body.disposition).toBe('shown');
  await act(() => h.scope.end());
  expect(screen.queryByText('A new place: CI planet 2')).toBeNull();
  await v.unmount();
});
it('a missing durable service stays honestly unavailable and explicit Refresh performs only another pure read', async () => {
  const h = fixture(true, false);
  h.session.setForeground(true);
  const v = await render(<FormationPresentation session={h.session} />);
  await waitFor(() => expect(screen.getByText('New-place views aren’t available right now.')).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh new-place view' }));
  await waitFor(() => expect(pathCalls(h, '/formation/read')).toHaveLength(2));
  expect(pathCalls(h, '/claim')).toHaveLength(0);
  expect(pathCalls(h, '/acknowledge')).toHaveLength(0);
  expect(screen.queryByRole('dialog')).toBeNull();
  await v.unmount();
});
