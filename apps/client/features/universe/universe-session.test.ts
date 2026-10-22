import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { waitFor } from '@testing-library/react-native';
import { createUniverseViewSession } from './universe-session';
import { universeSessionFor } from './use-universe-session';
import { fixtureId, fixtureAccount, sceneFixture, universeHarness } from './universe.fixture';
// Authored valid UUIDs replace Expo's native Jest UUID stub; production IDs are unchanged.
jest.mock('../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
const ready = async (session: ReturnType<typeof createUniverseViewSession>) =>
  waitFor(() => expect(session.getState().read.status).toBe('ready'));
it('loads through the real core; hierarchy/travel/Back restore the precise private frame without commands', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await ready(s);
  s.camera({ x: 21.5, y: -14, scale: 0.5 });
  s.focus(fixtureId(10));
  s.focus(fixtureId(12));
  const planet = s.getState().frame;
  expect(s.travel(fixtureId(8000))).toBe(true);
  expect(s.getState().focusId).toBe(fixtureId(13));
  s.back();
  expect(s.getState().frame).toEqual(planet);
  s.back();
  s.back();
  expect(s.getState().frame).toEqual({ x: 21.5, y: -14, scale: 0.5 });
  expect(s.focus(fixtureId(999))).toBe(false);
  expect(s.travel(fixtureId(999))).toBe(false);
  expect(h.calls.every((p) => p.startsWith('/v1/universe/'))).toBe(true);
  expect(h.store.keys()).toEqual([]);
  h.scope.end();
});
it('retains stale own labels, then clears every private resource on authority refusal and same-ID scope replacement', async () => {
  const h = universeHarness(),
    s = universeSessionFor(h.scope);
  s.setForeground(true);
  await ready(s);
  s.focus(fixtureId(12));
  const retained = s.descriptors()[0]!;
  s.geometry(retained);
  expect(s.cacheSize()).toBe(1);
  h.network(true);
  await s.refresh();
  expect(s.getState().read.reason).toBe('network');
  expect(s.places()[0]!.label).toBe('CI system 0');
  h.network(false);
  h.authority(true);
  await s.refresh();
  expect(s.getState().read.reason).toBe('authority');
  expect(s.places()).toEqual([]);
  expect(s.getState().historyDepth).toBe(0);
  expect(s.cacheSize()).toBe(0);
  expect(s.geometry(retained)).toBeUndefined();
  expect(s.cacheSize()).toBe(0);
  h.scope.end();
  const next = universeHarness();
  expect(next.scope.id).toBe(h.scope.id);
  expect(universeSessionFor(next.scope)).not.toBe(s);
  expect(s.getState().read.status).toBe('ended');
  next.scope.end();
});
it('fences late abort-ignoring replies after pause, capability replacement and scope end', async () => {
  const h = universeHarness();
  let release!: () => void;
  h.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await waitFor(() => expect(h.calls.length).toBe(1));
  s.setForeground(false);
  s.configure({ detail: 'low', reducedMotion: true });
  h.scope.end();
  release();
  await Promise.resolve();
  expect(s.getState().read.status).toBe('ended');
  expect(s.places()).toEqual([]);
  expect(s.cacheSize()).toBe(0);
});
it('accepts complete1000-place snapshots while bounding history and geometry, and empty stays distinct from loading', async () => {
  const h = universeHarness(1000),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await ready(s);
  expect(s.places()).toHaveLength(1000);
  for (const p of s.descriptors()) s.geometry(p);
  expect(s.cacheSize()).toBe(128);
  for (let n = 0; n < 50; n++) s.focus(fixtureId(12));
  expect(s.getState().historyDepth).toBe(32);
  h.scope.end();
  const e = universeHarness(0),
    empty = createUniverseViewSession(e.scope);
  expect(empty.getState().read.status).toBe('idle');
  empty.setForeground(true);
  await waitFor(() => expect(empty.getState().read.status).toBe('empty'));
  expect(empty.places()).toEqual([]);
  e.scope.end();
});
it('does not reuse a private return locator when the selected immutable chunk handle changes', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await ready(s);
  s.focus(fixtureId(12));
  const locator = s.getState().locator!;
  expect(locator.chunkId).toBe(h.world.chunks[0]!.chunkId);
  h.world.chunks[0]!.chunkId = fixtureId(20000); // adversarial but structurally valid protocol fixture, never product maintenance
  await s.refresh();
  expect(s.getState().read.status).toBe('ready');
  expect(s.getState().focusId).toBeNull();
  expect(s.getState().historyDepth).toBe(0);
  expect(s.getState().notice).toBe('place_unavailable');
  h.scope.end();
});

it('refuses retained geometry across pause and capability generations, even after replacement becomes ready', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await ready(s);
  const retained = s.descriptors()[0]!;
  expect(s.geometry(retained)).toBeDefined();
  s.setForeground(false);
  expect(s.geometry(retained)).toBeUndefined();
  s.configure({ detail: 'low', reducedMotion: false });
  expect(s.cacheSize()).toBe(0);
  expect(s.geometry(retained)).toBeUndefined();
  s.setForeground(true);
  await ready(s);
  expect(s.geometry(retained)).toBeUndefined();
  expect(s.cacheSize()).toBe(0);
  expect(s.geometry(s.descriptors()[0]!)).toBeDefined();
  expect(s.cacheSize()).toBe(1);
  h.scope.end();
});

it('Fit and Back preserve an exact matching canonical locator and camera frame', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await ready(s);
  s.focus(fixtureId(12));
  s.camera({ x: 81, y: -23, scale: 0.25 });
  expect(s.getState().locator?.frame).toEqual(s.getState().frame);
  s.fit();
  const fitted = s.getState();
  expect(fitted.frame).not.toEqual({ x: 81, y: -23, scale: 0.25 });
  expect(fitted.locator?.frame).toEqual(fitted.frame);
  s.focus(fixtureId(13));
  expect(s.back()).toBe(true);
  expect(s.getState().frame).toEqual(fitted.frame);
  expect(s.getState().locator).toEqual(fitted.locator);
  expect(s.getState().locator?.frame).toEqual(s.getState().frame);
  h.scope.end();
});

// These are authored HTTP protocol fixtures, not a supported real region/mapping.
function regionHarness() {
  const world = sceneFixture(),
    calls: { path: string; body: Record<string, unknown> }[] = [];
  let sequence = 400,
    gate: Promise<void> | undefined;
  const scope = createAccountScope({
    account: fixtureAccount,
    baseUrl: 'https://region.fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname,
        body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith('/region/preview')) {
        await gate;
        return new Response(
          JSON.stringify({
            ...body,
            status: 'available',
            scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
            geographyRevision: 3,
            recordedAt: '2026-10-22T00:00:00.000Z',
            encounter: {
              assetId: fixtureId(900),
              assetRevision: 1,
              metadata: { kind: 'scroll', title: 'CI canonical card', summary: 'Fixture only', language: 'en' },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/region/open'))
        return new Response(
          JSON.stringify({
            version: body.version,
            target: body.target,
            expectedEncounter: body.expectedEncounter,
            capabilities: body.capabilities,
            universeId: fixtureAccount.universeId,
            privacyEpoch: 1,
            outcome: {
              commandId: body.commandId,
              sessionId: fixtureId(901),
              decisionId: fixtureId(902),
              intentRevision: 1,
              revision: 40,
              replayed: false,
              status: 'exhausted',
              reason: 'no_eligible_content',
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      return new Response(JSON.stringify(world.reply(path, body)), { headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    scope,
    calls,
    session: createUniverseViewSession(scope, () => fixtureId(sequence++)),
    gate: (value: Promise<void>) => {
      gate = value;
    },
  };
}
it('opens only the displayed immutable card and returns exact scoped camera/history without recording map activity', async () => {
  const h = regionHarness(),
    s = h.session;
  s.setForeground(true);
  await ready(s);
  s.focus(fixtureId(14));
  s.camera({ x: 713.25, y: -28.75, scale: 0.75 });
  const before = s.getState();
  s.showOverlay('place');
  await waitFor(() => expect(s.getState().regionPreview.status).toBe('available'));
  const card = s.getState().regionPreview.preview!;
  let returned = 0;
  expect(
    s.openRegion(card, () => {
      returned++;
    }),
  ).toBe(true);
  const encounter = encounterSessionFor(h.scope);
  await waitFor(() => expect(encounter.getState().phase).toBe('exhausted'));
  const open = h.calls.find((c) => c.path.endsWith('/region/open'))!.body;
  expect(open.expectedEncounter).toEqual({ assetId: card.encounter.assetId, assetRevision: 1 });
  expect(Object.keys(open).sort()).toEqual(['capabilities', 'commandId', 'expectedEncounter', 'target', 'version']);
  s.setForeground(false);
  expect(encounter.back()).toBe(true);
  expect(returned).toBe(1);
  expect(s.getState().frame).toEqual(before.frame);
  expect(s.getState().locator).toEqual(before.locator);
  expect(s.getState().focusId).toBe(before.focusId);
  expect(s.getState().historyDepth).toBe(before.historyDepth);
  expect(s.getState().overlay).toBeNull();
  expect(h.calls.some((c) => /activate|observations|actions/.test(c.path))).toBe(false);
  h.scope.end();
});
it('Close, background and pin changes cancel previews; a retained old card cannot open after replacement', async () => {
  const h = regionHarness(),
    s = h.session;
  s.setForeground(true);
  await ready(s);
  s.focus(fixtureId(14));
  s.showOverlay('place');
  await waitFor(() => expect(s.getState().regionPreview.status).toBe('available'));
  const old = s.getState().regionPreview.preview!;
  s.back();
  expect(s.getState().regionPreview.status).toBe('idle');
  expect(s.openRegion(old, () => undefined)).toBe(false);
  let release!: () => void;
  h.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  s.showOverlay('place');
  await waitFor(() => expect(h.calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(2));
  s.setForeground(false);
  release();
  await Promise.resolve();
  expect(s.getState().regionPreview.preview).toBeUndefined();
  s.setForeground(true);
  await ready(s);
  s.focus(fixtureId(12));
  expect(s.openRegion(old, () => undefined)).toBe(false);
  expect(h.calls.filter((c) => c.path.endsWith('/region/open'))).toEqual([]);
  h.scope.end();
  expect(s.getState().regionPreview.status).toBe('ended');
});
it('formation is a pure current-map read until the service confirms a real claim, and scope end purges its separate controller', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  expect(s.formation.getState().status).toBe('idle');
  expect(h.calls).toEqual([]);
  s.setForeground(true);
  await ready(s);
  await waitFor(() => expect(s.formation.getState().status).toBe('unavailable'));
  expect(h.calls.filter((p) => p.endsWith('/formation/read'))).toHaveLength(1);
  expect(h.calls.some((p) => /formation\/(claim|acknowledge)|observations/.test(p))).toBe(false);
  h.scope.end();
  expect(s.formation.getState()).toEqual({ status: 'ended' });
  s.formation.retry();
  s.formation.setForeground(true);
  const next = universeHarness(),
    replacement = createUniverseViewSession(next.scope);
  expect(next.scope.id).toBe(h.scope.id);
  expect(replacement.formation.getState()).toEqual({ status: 'idle' });
  expect(next.calls).toEqual([]);
  next.scope.end();
});
