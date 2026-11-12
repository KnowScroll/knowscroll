import { waitFor } from '@testing-library/react-native';
import { UNIVERSE_SCENE_LIMITS } from '@knowscroll/client-core';
import { sceneCapabilities, createUniverseViewSession } from './universe-session';
import { saveUniverseMemory } from './universe-memory';
import { fixtureId, universeHarness } from './universe.fixture';

// Authored valid UUIDs replace Expo's native Jest UUID stub; production IDs are unchanged.
jest.mock('../../platform/command-id', () => {
  let next = 70000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});

/** The first world's system, then synthetic ones: `systemOf(n)` is the system `n` of the extras. */
const main = fixtureId(10);
const systemOf = (n: number) => fixtureId(20_000 + n * 10);
const MAP_SYSTEMS = 3000;
const open = () => universeHarness(5, 0, 0, MAP_SYSTEMS - 1);
const started = async (h: ReturnType<typeof open>) => {
  const s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await waitFor(() => expect(s.getState().read.status).toBe('ready'), { timeout: 5000 });
  return s;
};
const loaded = (s: ReturnType<typeof createUniverseViewSession>) => s.getState().read.loadedSystemIds ?? [];
const planetsOf = (s: ReturnType<typeof createUniverseViewSession>, systemId: string) =>
  s.places().filter((place) => place.kind === 'planet' && place.parentId === systemId);
const geographyReads = (h: ReturnType<typeof open>) => h.calls.filter((path) => path.endsWith('/geography/read'));

it('declares the sky capability, after looks and in the schema order the session compares by', () => {
  const capabilities = sceneCapabilities('full', false);
  expect(capabilities.sky).toEqual(['scene-sky.v1']);
  expect(Object.keys(capabilities).slice(5, 8)).toEqual(['families', 'looks', 'sky']);
});

it('holds a map of 3,000 systems as its sky and builds none of their planets until they are wanted', async () => {
  const h = open(),
    s = await started(h);
  const systems = s.places().filter((place) => place.kind === 'system');
  // Every system is a label the lists and search can name; none of them has been opened.
  expect(systems).toHaveLength(MAP_SYSTEMS);
  expect(s.places().filter((place) => place.kind !== 'system')).toEqual([]);
  expect(s.getState().read.sky?.systems).toHaveLength(MAP_SYSTEMS);
  expect(loaded(s)).toEqual([]);
  expect(h.calls.filter((path) => path.endsWith('/scenes/sky/read'))).toHaveLength(15);
  expect(geographyReads(h)).toHaveLength(0);
  expect(h.calls.filter((path) => path.endsWith('/chunks/read'))).toHaveLength(0);
  expect(s.descriptors()).toHaveLength(MAP_SYSTEMS);
  h.scope.end();
});

it('loads the one system the drawing reports in detail and nothing else', async () => {
  const h = open(),
    s = await started(h);
  s.setDetail([systemOf(5)]);
  await waitFor(() => expect(planetsOf(s, systemOf(5))).toHaveLength(2), { timeout: 5000 });
  expect(loaded(s)).toEqual([systemOf(5)]);
  expect(geographyReads(h)).toHaveLength(1);
  expect(h.requests.find((request) => request.path.endsWith('/geography/read'))?.body).toMatchObject({
    selection: { kind: 'system', systemId: systemOf(5) },
    version: 'geography-read.v2',
  });
  expect(s.getState().read.snapshot?.chunks).toHaveLength(1);
  expect(planetsOf(s, systemOf(6))).toEqual([]);
  h.scope.end();
});

it('loads the system a person flies to and keeps it while the camera is in it', async () => {
  const h = open(),
    s = await started(h);
  expect(s.focus(systemOf(40))).toBe(true);
  await waitFor(() => expect(planetsOf(s, systemOf(40))).toHaveLength(2), { timeout: 5000 });
  // A drawing that reports something else in detail does not let go of the system the camera is in.
  s.setDetail([systemOf(41)]);
  await waitFor(() => expect(loaded(s)).toContain(systemOf(41)), { timeout: 5000 });
  s.setDetail([]);
  expect(loaded(s)).toContain(systemOf(40));
  // Opening one of its planets works at once: it is loaded.
  const planet = planetsOf(s, systemOf(40))[0]!;
  expect(s.focus(planet.id)).toBe(true);
  expect(s.getState().focusId).toBe(planet.id);
  // Back returns to the system, which is still on the map.
  s.back();
  expect(s.getState().focusId).toBe(systemOf(40));
  expect(s.getState().notice).toBeUndefined();
  h.scope.end();
});

it('lets go of systems nobody wants any more, keeping the 24 most recent for a moment', async () => {
  const h = open(),
    s = await started(h);
  const first = Array.from({ length: 30 }, (_, n) => systemOf(100 + n));
  s.setDetail(first);
  await waitFor(() => expect(loaded(s)).toHaveLength(30), { timeout: 10_000 });
  s.setDetail([systemOf(200)]);
  await waitFor(() => expect(loaded(s)).toContain(systemOf(200)), { timeout: 5000 });
  expect(loaded(s)).toHaveLength(UNIVERSE_SCENE_LIMITS.loadedSystems + 1);
  // The oldest were dropped from what the map holds and from what it lists.
  expect(planetsOf(s, systemOf(100))).toEqual([]);
  expect(planetsOf(s, systemOf(129))).toHaveLength(2);
  expect(s.places().filter((place) => place.kind === 'system')).toHaveLength(MAP_SYSTEMS);
  h.scope.end();
});

it('loads the planets of the system a list or the dial is open on, and lets them go when it closes', async () => {
  const h = open(),
    s = await started(h);
  s.keepSystems([systemOf(7)]);
  await waitFor(() => expect(planetsOf(s, systemOf(7))).toHaveLength(2), { timeout: 5000 });
  s.keepSystems([]);
  expect(loaded(s)).toEqual([systemOf(7)]);
  h.scope.end();
});

it('loads a small map whole, as it always did, without anyone asking', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await waitFor(() => expect(s.getState().read.status).toBe('ready'));
  // The first drawing waited for the planets: the map is never seen without them.
  expect(loaded(s)).toEqual([main]);
  expect(s.places().map((place) => place.kind)).toContain('planet');
  expect(s.getState().read.snapshot?.chunks.length).toBeGreaterThan(0);
  h.scope.end();
});

const remember = (h: ReturnType<typeof open>, focus: { id: string; kind: 'system' | 'planet' }) =>
  saveUniverseMemory(h.scope, {
    focusId: focus.id,
    landed: false,
    frame: { x: 3, y: 4, scale: 1.5 },
    lately: false,
    simple: false,
    lastPlace: { id: focus.id, label: 'Remembered', kind: focus.kind },
    seenAt: Date.now(),
  });

it('restores the system a person left the camera in, whose planets load with it', async () => {
  const h = open();
  remember(h, { id: systemOf(9), kind: 'system' });
  const s = await started(h);
  expect(s.getState().focusId).toBe(systemOf(9));
  expect(s.getState().frame).toEqual({ x: 3, y: 4, scale: 1.5 });
  await waitFor(() => expect(planetsOf(s, systemOf(9))).toHaveLength(2), { timeout: 5000 });
  h.scope.end();
});

it('falls back to the whole map, quietly, for a remembered planet whose system is not loaded', async () => {
  // A map of thousands of systems loads a system when it is wanted, and a planet is not known before then: the
  // camera does not return into it (the limitation D-417 records), and nothing says a place is gone.
  const h = open();
  remember(h, { id: fixtureId(20_000 + 9 * 10 + 2), kind: 'planet' });
  const s = await started(h);
  expect(s.getState().focusId).toBeNull();
  expect(s.getState().notice).toBeUndefined();
  expect(s.getState().lastPlace).toBeUndefined();
  h.scope.end();
});
