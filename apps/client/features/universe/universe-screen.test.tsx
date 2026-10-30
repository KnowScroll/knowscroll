import type * as React from 'react';
import type * as FakeGpu from './space/fake-space-gpu';
import { type EffectCallback, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { UniverseScreen } from './universe-screen';
import { fakeGpu, resetFakeGpu } from './space/fake-space-gpu';
import { fixtureAccount, fixtureId, sceneFixture, universeHarness } from './universe.fixture';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import type { AccountScope } from '@knowscroll/client-core';
let mockScope: AccountScope;
// Authored valid UUIDs replace Expo's native Jest UUID stub; production IDs are unchanged.
jest.mock('../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
/** The Universe reads the map, and the room stations beside it: reads both, and nothing else. */
const universeRead = (path: string) => path.startsWith('/v1/universe/') || path === '/v1/rooms/stations';
// The real stage, loop and overlay over a stand-in for the GPU (no WebGL claimed; e2e/universe-smoke.spec.ts draws for real).
jest.mock('./space/space-canvas', () => ({
  SpaceCanvas: jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.Canvas,
}));
jest.mock('./space/load-space-renderer', () => ({
  loadSpaceRenderer: () => jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.load(),
}));
const mockNavigate = jest.fn();
const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useIsFocused: () => true,
    useRouter: () => ({ navigate: mockNavigate, push: mockPush, canGoBack: () => false }),
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
  resetFakeGpu();
  mockNavigate.mockReset();
  mockPush.mockReset();
  mockParams = {};
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});
it('mounts the real core in StrictMode; shows loading, then actual empty without invented worlds', async () => {
  const h = universeHarness(0);
  mockScope = h.scope;
  let release!: () => void;
  h.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const v = await render(
    <StrictMode>
      <UniverseScreen />
    </StrictMode>,
  );
  expect(screen.queryByText('Your universe starts quiet.')).toBeNull();
  await act(() => {
    release();
  });
  await waitFor(() => expect(screen.getByText('Your universe starts quiet.')).toBeOnTheScreen());
  expect(h.calls.every(universeRead)).toBe(true);
  await v.unmount();
  h.scope.end();
});
it('draws the real map; the list view reaches a region whose card never manufactures an encounter', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4, region in CI planet 2, CI system 0' }));
  await waitFor(() => expect(screen.getByText('Encounters from this region aren’t available yet.')).toBeOnTheScreen());
  await waitFor(() => expect(h.calls.filter((p) => p.endsWith('/region/preview'))).toHaveLength(1));
  expect(h.calls.every((p) => universeRead(p) || p === '/v1/experience/region/preview')).toBe(true);
  expect(h.calls.some((p) => /region\/open|activate|observations/.test(p))).toBe(false);
  await act(() => h.scope.end());
  expect(screen.queryByText('CI region 4')).toBeNull();
  await v.unmount();
});

it('flies from the map into a system and a planet, with Back steps up and the ship parked where they went', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  expect(screen.getByRole('header', { name: 'Your universe' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
  expect(screen.getByText('Tap a region to land.')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to CI system 0' }));
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
  expect(screen.getByRole('button', { name: 'Return to CI planet 2' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Return to CI planet 2' }));
  expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});

it('searches and toggles Lately without leaving the map, and none of it is a command', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Search your universe' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Lately' }));
  expect(h.scope.storage.get('universe.view.v1')).toContain('"lately":true');
  await fireEvent.press(screen.getByRole('button', { name: 'Search your universe' }));
  await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'planet 3');
  await fireEvent.press(screen.getByRole('button', { name: /CI planet 3, planet/ }));
  expect(screen.getByRole('header', { name: 'CI planet 3' })).toBeOnTheScreen();
  await fireEvent.changeText(
    screen.queryByLabelText('Search your universe') ?? screen.getByRole('header', { name: 'CI planet 3' }),
    'x',
  );
  expect(h.calls.every((p) => universeRead(p) || p === '/v1/experience/region/preview')).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('shows dust as an unlabelled, non-navigable cue before any system exists', async () => {
  const h = universeHarness(0, 1);
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  const cue = await screen.findByRole('button', { name: 'Recent reading is gathering here' });
  expect(screen.queryByText('Your universe starts quiet.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
  await fireEvent.press(cue);
  expect(screen.getByText('Recent explorations are gathering here.')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Close note' }));
  expect(screen.queryByText('Recent explorations are gathering here.')).toBeNull();
  await act(() => h.scope.end());
  await v.unmount();
});

it('flies to the last place on ?focus=last, from the whole map', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const first = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
  expect(screen.getByRole('header', { name: 'Your universe' })).toBeOnTheScreen();
  await first.unmount();
  mockParams = { focus: 'last' };
  const second = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen());
  await act(() => h.scope.end());
  await second.unmount();
});

it('follows a route by its chip from either planet, and draws no route line', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  // A route is a relation, not a line (D-074): the system view has no route target at all.
  expect(screen.queryByRole('button', { name: /^Route (from|to) / })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Route to CI planet 3' }));
  expect(screen.getByRole('header', { name: 'CI planet 3' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Route to CI planet 2' }));
  expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
  expect(h.calls.every(universeRead)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('asks for the looks and draws the types, rings, moon and haze the server gave, nothing of its own', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  const manifest = h.requests.find((request) => request.path.endsWith('/manifest/read'))!;
  expect(manifest.body.capabilities).toMatchObject({ looks: ['scene-look.v1'] });
  expect((manifest.body.capabilities as { generators: string[] }).generators).toContain('worldmap.v1');
  const [system] = fakeGpu.renderers.at(-1)!.definition.systems;
  const served = new Map(h.world.looks.map((look) => [look.objectId, look]));
  expect(system!.family).toBe((served.get(system!.id) as { haze: string }).haze);
  expect(system!.planets.length).toBeGreaterThan(0);
  for (const planet of system!.planets) {
    const look = served.get(planet.id) as { type: string; rings: boolean; moon: boolean; hueShift: number };
    expect(planet).toMatchObject({ type: look.type, rings: look.rings, moon: look.moon, hueShift: look.hueShift });
  }
  await act(() => h.scope.end());
  await v.unmount();
});

it('flies the camera into a system and back out inside one scene', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  const renderer = fakeGpu.renderers.at(-1)!;
  expect(renderer.cameras.at(-1)!.spec.focus.kind).toBe('universe');
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await waitFor(() => expect(renderer.cameras.at(-1)!.spec.focus.kind).toBe('system'));
  // The same scene is kept, so the renderer flies: it was told to animate.
  expect(fakeGpu.renderers.at(-1)).toBe(renderer);
  expect(renderer.cameras.at(-1)!.animate).toBe(true);
  // Only the planets of the system are reached, and none of them is a route.
  expect(screen.getByRole('button', { name: 'CI planet 2, a planet' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
  await waitFor(() => expect(renderer.cameras.at(-1)!.spec.focus.kind).toBe('universe'));
  await act(() => h.scope.end());
  await v.unmount();
});

it('picks a system on the Far level before it enters, then enters on the next tap', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  fakeGpu.far = true;
  const v = await render(<UniverseScreen />);
  const system = await screen.findByRole('button', { name: 'CI system 0, a system' });
  await fireEvent.press(system);
  expect(screen.getByTestId('universe-system-card')).toBeOnTheScreen();
  expect(fakeGpu.renderers.at(-1)!.highlighted).toBe(fixtureId(10));
  expect(screen.queryByRole('button', { name: 'Back to Universe' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Open system' }));
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});

it('shows the same places as plain lists when 3D cannot be made, and every one still opens', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  fakeGpu.failToCreate = true;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByTestId('ks-space-simple')).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  expect(screen.getByRole('button', { name: 'Back to Universe' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0' }));
  expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
  expect(h.calls.every(universeRead)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('parks the ship at the planet of the last place, and hides it under Lately', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Back to CI system 0' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
  const renderer = fakeGpu.renderers.at(-1)!;
  await waitFor(() => expect(renderer.definition.shipPlanetId).toBe(fixtureId(12)));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Lately' }));
  await waitFor(() => expect(renderer.definition.shipPlanetId).toBeUndefined());
  await act(() => h.scope.end());
  await v.unmount();
});

it('lists the places as an outline that names where each one is', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  expect(screen.getByRole('button', { name: 'CI system 0, system' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'CI planet 2, planet in CI system 0' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'CI region 4, region in CI planet 2, CI system 0' })).toBeOnTheScreen();
  expect(screen.getAllByRole('header', { name: 'CI system 0' }).length).toBeGreaterThan(0);
  await act(() => h.scope.end());
  await v.unmount();
});

it('shows only an actual correlated card; deliberate Open sends displayed ref and exact local map return closes the dialog', async () => {
  const world = sceneFixture(),
    calls: { path: string; body: Record<string, unknown> }[] = [];
  const scope = createAccountScope({
    account: fixtureAccount,
    baseUrl: 'https://universe.fixture.test',
    store: memoryStore(),
    authorization: () => undefined,
    fetch: async (request) => {
      const path = new URL(request.url).pathname,
        body = (await request.json()) as Record<string, unknown>;
      if (path === '/v1/privacy/recording/read')
        return new Response(
          JSON.stringify({
            ...body,
            scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
            revision: 1,
            policy: { on: true, generation: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      calls.push({ path, body });
      let value: unknown;
      if (path.endsWith('/region/preview'))
        value = {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
          recordedAt: '2026-10-22T00:00:00.000Z',
          geographyRevision: 3,
          status: 'available',
          encounter: {
            assetId: fixtureId(910),
            assetRevision: 2,
            metadata: {
              kind: 'scroll',
              title: 'CI region explanation',
              summary: 'A fixture, not generated content.',
              language: 'en',
            },
          },
        };
      else if (path.endsWith('/region/open'))
        value = {
          version: body.version,
          universeId: fixtureAccount.universeId,
          privacyEpoch: 1,
          target: body.target,
          expectedEncounter: body.expectedEncounter,
          capabilities: body.capabilities,
          outcome: {
            commandId: body.commandId,
            sessionId: fixtureId(911),
            decisionId: fixtureId(912),
            intentRevision: 1,
            revision: 40,
            replayed: false,
            status: 'exhausted',
            reason: 'no_eligible_content',
          },
        };
      else value = world.reply(path, body);
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    },
  });
  let recordingReadId = 9900;
  scope.recording?.useIdSource(() => fixtureId(++recordingReadId));
  mockScope = scope;
  const view = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4, region in CI planet 2, CI system 0' }));
  await waitFor(() => expect(screen.getByText('CI region explanation')).toBeOnTheScreen());
  expect(calls.filter((c) => c.path.endsWith('/region/open'))).toHaveLength(0);
  expect(calls.some((c) => /activate|observations|actions/.test(c.path))).toBe(false);
  await fireEvent.press(screen.getByRole('button', { name: /^Open$/ }));
  await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/region/open'))).toHaveLength(1));
  expect(calls.find((c) => c.path.endsWith('/region/open'))!.body.expectedEncounter).toEqual({
    assetId: fixtureId(910),
    assetRevision: 2,
  });
  expect(mockNavigate).toHaveBeenCalledWith('/explore');
  await waitFor(() => expect(encounterSessionFor(scope).getState().phase).toBe('exhausted'));
  await act(() => {
    expect(encounterSessionFor(scope).back()).toBe(true);
  });
  expect(mockNavigate).toHaveBeenCalledWith('/universe');
  expect(screen.queryByTestId('universe-region-card')).toBeNull();
  expect(screen.getByRole('button', { name: 'Back to CI planet 2' })).toBeOnTheScreen();
  // U04: the pin left through its card says so, and is still the selected place.
  expect(
    screen.getByRole('button', { name: 'CI region 4 · you were here, a region' }).props.accessibilityState,
  ).toMatchObject({ selected: true });
  expect(screen.getAllByText('CI region 4 · you were here').length).toBeGreaterThan(0);
  await act(() => scope.end());
  await view.unmount();
});
it('a missing formation service shows an honest unavailable state without a birth, claim or shown acknowledgement', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByText('New-place views aren’t available right now.')).toBeOnTheScreen());
  expect(screen.queryByText(/A new place:/)).toBeNull();
  expect(h.calls.filter((p) => p.endsWith('/formation/read'))).toHaveLength(1);
  expect(h.calls.some((p) => /formation\/(claim|acknowledge)|observations/.test(p))).toBe(false);
  await act(() => h.scope.end());
  expect(screen.queryByText('New-place views aren’t available right now.')).toBeNull();
  await v.unmount();
});

it('the simple drawing keeps every region reachable as a plain list', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple drawing' }));
  await waitFor(() => expect(screen.getByText('Low detail')).toBeOnTheScreen());
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'CI region 4' }).length).toBeGreaterThan(0));
  await act(() => h.scope.end());
  await v.unmount();
});

/** A room whose topic is the fixture's first system: the station sits beside it, and opens the room (R01). */
const roomStation = () => ({
  room: {
    roomId: '0199d000-0000-7000-8000-0000000000a1',
    name: 'CI room',
    description: 'A room about the first system.',
    topic: { kind: 'system' as const, id: 'ci-topic', label: 'CI topic' },
    joinRule: 'open' as const,
    status: 'open' as const,
  },
  standing: 'none' as const,
  placement: { systemId: fixtureId(10) },
});

it('draws a room station beside the system of its topic, lists it under Rooms, and opens the room from either', async () => {
  const h = universeHarness();
  h.world.stations.push(roomStation());
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  const id = roomStation().room.roomId;
  await waitFor(() => expect(screen.getByTestId(`universe-station-${id}`)).toBeOnTheScreen());
  expect(screen.getByRole('button', { name: 'CI room, a room station' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId(`universe-station-${id}`));
  expect(mockPush).toHaveBeenLastCalledWith(`/rooms/${id}`);
  // The accessible list view names it too, after the places, and opens the same room.
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByTestId(`universe-outline-station-${id}`));
  expect(mockPush).toHaveBeenCalledTimes(2);
  // It is decoration beside a place: no count, no activity, and nothing is written.
  expect(h.calls.every(universeRead)).toBe(true);
  expect(screen.queryByText(/members|online|active now/i)).toBeNull();
  await act(() => h.scope.end());
  await v.unmount();
});

it('draws a station inside its system too, and none where the map holds no system of its topic', async () => {
  const h = universeHarness();
  const elsewhere = roomStation();
  h.world.stations.push(roomStation(), {
    ...elsewhere,
    room: { ...elsewhere.room, roomId: '0199d000-0000-7000-8000-0000000000a2', name: 'Elsewhere room' },
    placement: { systemId: fixtureId(9999) },
  });
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  expect(screen.queryByRole('button', { name: 'Elsewhere room, a room station' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI room, a room station' })).toBeOnTheScreen());
  expect(screen.queryByRole('button', { name: 'Elsewhere room, a room station' })).toBeNull();
  await act(() => h.scope.end());
  await v.unmount();
});
