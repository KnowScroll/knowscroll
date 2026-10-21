import { waitFor } from '@testing-library/react-native';
import { createUniverseViewSession } from './universe-session';
import { universeSessionFor } from './use-universe-session';
import { fixtureId, universeHarness } from './universe.fixture';
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
  s.geometry(h.world.descriptors[0]!);
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
  for (const p of h.world.descriptors) s.geometry(p);
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
