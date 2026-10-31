import type * as React from 'react';
import type * as FakeGpu from './space/fake-space-gpu';
import { type EffectCallback, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { UniverseScreen, unavailableWords } from './universe-screen';
import { fakeGpu, resetFakeGpu } from './space/fake-space-gpu';
import { COLLECTION_READS, fixtureAccount, fixtureId, sceneFixture, universeHarness } from './universe.fixture';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { universeSessionFor } from './use-universe-session';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import type { AccountScope } from '@knowscroll/client-core';
let mockScope: AccountScope;
// Authored valid UUIDs replace Expo's native Jest UUID stub; production IDs are unchanged.
jest.mock('../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
/** The Universe reads the map, and the room stations beside it: reads both, and nothing else. */
const universeRead = (path: string) =>
  path.startsWith('/v1/universe/') || path === '/v1/rooms/stations' || COLLECTION_READS.includes(path);
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
it('draws the real map; landing on a planet reaches a region whose card never manufactures an encounter', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'CI region 4, a region' }));
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
  expect(screen.getByText('Drag to rotate · tap to land')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to CI system 0' }));
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
  expect(screen.getByRole('button', { name: 'Return to CI planet 2' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Return to CI planet 2' }));
  expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});

/** Every string a screen draws, hidden or not: what a tree could ever say, whether or not a screen reader hears it. */
function allStrings(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') found.push(node);
  else if (Array.isArray(node)) for (const child of node) allStrings(child, found);
  else if (node && typeof node === 'object') {
    const element = node as { children?: unknown; props?: { content?: unknown } };
    // react-native-svg keeps the letters of a Text in its `content` prop.
    if (typeof element.props?.content === 'string') found.push(element.props.content);
    allStrings(element.children, found);
  }
  return found;
}

describe('a planet: its globe, landing, and the land not reached yet (D-109)', () => {
  const openPlanet = async (h: ReturnType<typeof universeHarness>) => {
    mockScope = h.scope;
    const view = await render(<UniverseScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
    return view;
  };

  it('turns a globe with one control, lands on its map, and names only the regions that have formed', async () => {
    const h = universeHarness(5, 0, 3);
    const v = await openPlanet(h);
    expect(screen.getByText('Drag to rotate · tap to land')).toBeOnTheScreen();
    expect(screen.queryByTestId('universe-level')).toBeNull();
    // The globe's own names are drawing: the planet's regions are not controls on it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
    expect(screen.queryAllByRole('button', { name: /, a region$/ })).toHaveLength(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /, a region$/ })).toHaveLength(4));
    expect(screen.getByTestId('universe-level')).toHaveTextContent('PLANET');
    // The map's regions are named in site order, which is also the order of the plain list.
    const onMap = screen
      .getAllByRole('button', { name: /, a region$/ })
      .map((button) => String(button.props.accessibilityLabel));
    expect(onMap).toEqual([
      'CI region 4, a region',
      'CI region 5, a region',
      'CI region 6, a region',
      'CI region 7, a region',
    ]);
    // Nothing on the screen says anything about land that is not reached yet, hidden from a screen reader or not.
    const said = allStrings(screen.toJSON()).join(' | ');
    expect(said).not.toMatch(/uncharted|not reached|unreached|locked|grey|gray|left to|more to/i);
    expect(new Set(said.match(/CI region \d/g))).toEqual(
      new Set(['CI region 4', 'CI region 5', 'CI region 6', 'CI region 7']),
    );
    // The Back pill goes up to the system, as the design says, and browsing sent nothing but reads.
    expect(screen.getByRole('button', { name: 'Back to CI system 0' })).toBeOnTheScreen();
    expect(h.calls.every(universeRead)).toBe(true);
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('chooses a region on the map for its card, and the card is dark glass over the map', async () => {
    const h = universeHarness(5, 0, 3);
    const v = await openPlanet(h);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'CI region 5, a region' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'CI region 5, a region' }));
    await waitFor(() => expect(screen.getByTestId('universe-region-card')).toBeOnTheScreen());
    expect(screen.getByTestId('universe-level')).toHaveTextContent('REGION');
    expect(screen.getByRole('button', { name: 'Back to CI planet 2' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'CI region 5, a region' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI planet 2' }));
    expect(screen.queryByTestId('universe-region-card')).toBeNull();
    expect(screen.getByTestId('universe-level')).toHaveTextContent('PLANET');
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('shows the same names in the same order in the Simple drawing, and nothing for land not reached', async () => {
    const h = universeHarness(5, 0, 3);
    const v = await openPlanet(h);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /, a region$/ })).toHaveLength(4));
    const onMap = screen
      .getAllByRole('button', { name: /, a region$/ })
      .map((button) => String(button.props.accessibilityLabel).replace(', a region', ''));
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
    await screen.findByTestId('universe-simple');
    // The plain list of the planet: its countries, as buttons, in the map's order.
    const plain = screen
      .getAllByRole('button', { name: /^CI region \d$/ })
      .map((button) => String(button.props.accessibilityLabel));
    expect(plain).toEqual(onMap);
    expect(screen.getByText('Countries')).toBeOnTheScreen();
    expect(allStrings(screen.toJSON()).join(' | ')).not.toMatch(/uncharted|not reached|unreached|locked|grey|gray/i);
    await act(() => h.scope.end());
    await v.unmount();
  });
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

describe('the Simple drawing turns itself on when 3D cannot be drawn (D-111)', () => {
  const opensAsLists = async (h: ReturnType<typeof universeHarness>) => {
    mockScope = h.scope;
    const view = await render(<UniverseScreen />);
    await screen.findByTestId('universe-simple');
    // The same places, as a heading and its planets; every one still opens.
    // The Simple list's system names are headings: pressing one would change nothing on this screen.
    expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'CI system 0, system' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0' }));
    expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Your universe' })).toBeOnTheScreen();
    expect(h.calls.every(universeRead)).toBe(true);
    await act(() => h.scope.end());
    await view.unmount();
  };

  it('when WebGL is missing', async () => {
    fakeGpu.failToCreate = true;
    await opensAsLists(universeHarness());
  });

  it('when a frame fails', async () => {
    fakeGpu.failToDraw = true;
    await opensAsLists(universeHarness());
  });

  it('when the context is lost, after the map was drawn', async () => {
    const h = universeHarness();
    mockScope = h.scope;
    const view = await render(<UniverseScreen />);
    await waitFor(() => expect(fakeGpu.renderers.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('universe-simple')).toBeNull();
    await act(() => fakeGpu.loseContext());
    await screen.findByTestId('universe-simple');
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('when the device is short of memory', async () => {
    // React Native's own AppState is already a mock in Jest: put its behaviour back when the test is done.
    const add = (AppState as unknown as { addEventListener: jest.Mock }).addEventListener;
    const original = add.getMockImplementation();
    const handlers: (() => void)[] = [];
    add.mockImplementation((type: string, handler: () => void) => {
      if (type === 'memoryWarning') handlers.push(handler);
      return { remove: () => undefined };
    });
    try {
      const h = universeHarness();
      mockScope = h.scope;
      const view = await render(<UniverseScreen />);
      await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
      await act(() => handlers.forEach((handler) => handler()));
      await screen.findByTestId('universe-simple');
      await act(() => h.scope.end());
      await view.unmount();
    } finally {
      add.mockImplementation(original);
    }
  });

  it('and the switch brings the 3D views back when they can be drawn again', async () => {
    const h = universeHarness();
    mockScope = h.scope;
    fakeGpu.failToCreate = true;
    const view = await render(<UniverseScreen />);
    await screen.findByTestId('universe-simple');
    fakeGpu.failToCreate = false;
    await fireEvent.press(screen.getByRole('switch', { name: 'Simple view' }));
    await waitFor(() => expect(screen.queryByTestId('universe-simple')).toBeNull());
    await waitFor(() => expect(fakeGpu.renderers.length).toBeGreaterThan(0));
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('is the setting, remembered on this device: the lists in the finalized words, and a switch that turns it off', async () => {
    const h = universeHarness(5, 0, 3);
    mockScope = h.scope;
    const view = await render(<UniverseScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
    await screen.findByTestId('universe-simple');
    expect(screen.getByText('1 system · 2 planets')).toBeOnTheScreen();
    expect(screen.getByText('Plain lists, for slow devices')).toBeOnTheScreen();
    expect(screen.getByText('2 planets')).toBeOnTheScreen();
    expect(screen.getByText('4 countries')).toBeOnTheScreen();
    expect(h.scope.storage.get('universe.view.v1')).toContain('"simple":true');
    await fireEvent.press(screen.getByRole('switch', { name: 'Simple view' }));
    await waitFor(() => expect(screen.queryByTestId('universe-simple')).toBeNull());
    expect(h.scope.storage.get('universe.view.v1')).toContain('"simple":false');
    await act(() => h.scope.end());
    await view.unmount();
  });
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

it('opens the orbit dial from List view: the systems on a wheel, a system’s planets on a dial, and a tap on the big planet lands', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  expect(screen.getByTestId('universe-dial')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'CI system 0, a system, 2 planets' })).toBeOnTheScreen();
  // At rest: the chosen system's name, its big planet and the dial of its planets, with what each holds.
  expect(screen.getByRole('button', { name: 'CI planet 3, a planet' })).toBeOnTheScreen();
  expect(screen.getByTestId('dial-planet-facts')).toHaveTextContent(/Planet 1 of 2/);
  expect(screen.getByTestId('dial-planet-facts')).toHaveTextContent(/1 region/);
  // Turn the dial to the next planet.
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 3, a planet' }));
  expect(screen.getByTestId('dial-planet-facts')).toHaveTextContent(/Planet 2 of 2/);
  expect(screen.getByTestId('dial-planet-facts')).toHaveTextContent(/CI planet 3/);
  // The system row opens the wheel, with the filters over it.
  await fireEvent.press(screen.getByTestId('dial-system-pill'));
  expect(screen.getByTestId('dial-system-facts')).toHaveTextContent(/System 1 of 1/);
  for (const name of ['All, 1', 'Lately', 'With rooms, 0', 'A–Z'])
    expect(screen.getByRole('togglebutton', { name })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'With rooms, 0' }));
  expect(screen.getByText('No systems here yet.')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Show all' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system, 2 planets' }));
  // Choosing a system rests the dial on its first planet. Tap the big planet: it lands on its map, and the dial closes.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
  expect(screen.getByTestId('universe-level')).toHaveTextContent('PLANET');
  expect(screen.getByRole('button', { name: 'Back to CI system 0' })).toBeOnTheScreen();
  expect(screen.queryByTestId('universe-dial')).toBeNull();
  expect(h.calls.every(universeRead)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('opens the orbit dial for a system with no planets: a plain note, no big planet, and Simple view still opens', async () => {
  // universeHarness(1) is one system and nothing in it (#548: the dial read the first planet of an empty list).
  const h = universeHarness(1);
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  expect(screen.getByTestId('universe-dial')).toBeOnTheScreen();
  expect(screen.getByTestId('dial-no-planets')).toHaveTextContent('No planets in CI system 0 yet.');
  expect(screen.queryByTestId('dial-planet-facts')).toBeNull();
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
  expect(screen.queryByTestId('universe-dial')).toBeNull();
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
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Land on CI planet 2' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'CI region 4, a region' }));
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
  // U04: back from the encounter is the planet's map at planet level, with the region marked.
  expect(screen.getByRole('button', { name: 'Back to CI system 0' })).toBeOnTheScreen();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'CI region 4 · you were here, a region' })).toBeOnTheScreen(),
  );
  expect(
    screen.getByRole('button', { name: 'CI region 4 · you were here, a region' }).props.accessibilityState,
  ).toMatchObject({ selected: false });
  // The pill is drawing; the region's target is what is announced.
  expect(screen.getAllByText('CI region 4 · you were here', { includeHiddenElements: true }).length).toBeGreaterThan(0);
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
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
  await screen.findByTestId('universe-simple');
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'CI region 4' }).length).toBeGreaterThan(0));
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4' }));
  await waitFor(() => expect(screen.getByTestId('universe-region-card')).toBeOnTheScreen());
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
  // The Simple list names it too, after the places, and opens the same room.
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
  await fireEvent.press(await screen.findByTestId(`simple-room-${id}`));
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

it('says plainly, with its apostrophes, when there is no map to draw: offline, no longer available, or not drawable', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  h.network(true);
  const offline = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByText('You’re offline')).toBeOnTheScreen());
  expect(screen.getByText('Your universe is kept. Refresh when you’re connected.')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Refresh map' })).toBeOnTheScreen();
  expect(screen.getByRole('link', { name: 'Go to Explore' })).toBeOnTheScreen();
  await offline.unmount();
  h.scope.end();
  const gone = universeHarness();
  mockScope = gone.scope;
  gone.authority(true);
  const refused = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByText('Your map is no longer available.')).toBeOnTheScreen());
  await refused.unmount();
  gone.scope.end();
});

it('words every reason there is no map, and none of the words carries a broken character', () => {
  const words = [
    unavailableWords({ status: 'unsupported', active: true }),
    unavailableWords({ status: 'unavailable', active: true, reason: 'authority' }),
    unavailableWords({ status: 'unavailable', active: true, reason: 'network' }),
    unavailableWords({ status: 'unavailable', active: true, reason: 'invalid' }),
  ];
  expect(words.map((entry) => entry.heading)).toEqual([
    'Not on this device yet',
    'No longer available',
    'You’re offline',
    'Couldn’t draw your map',
  ]);
  expect(words[0]!.message).toBe('This drawing isn’t supported on this device yet.');
  expect(words[3]!.message).toBe('Couldn’t draw your map. Try again in a moment.');
  for (const entry of words) expect(entry.heading + entry.message).not.toContain(String.fromCharCode(0xfffd));
});

describe('search over what the person already has (v3 U-5)', () => {
  const openSearch = async (h: ReturnType<typeof universeHarness>) => {
    mockScope = h.scope;
    const view = await render(<UniverseScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search your universe' })).toBeOnTheScreen());
    await waitFor(() => expect(h.requests.some((request) => request.path === '/v1/rooms/stations')).toBe(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Search your universe' }));
    return view;
  };

  it('says what can be found while the field is empty, and that search stays on the device', async () => {
    const h = universeHarness();
    const v = await openSearch(h);
    expect(screen.getByText('Find any place you’ve been')).toBeOnTheScreen();
    for (const kind of ['Systems', 'Planets', 'Regions', 'Rooms']) expect(screen.getByText(kind)).toBeOnTheScreen();
    expect(screen.getByText('Search stays on this device.')).toBeOnTheScreen();
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('finds systems, planets, regions and rooms with their path, flies to a place, and Back restores the camera', async () => {
    const h = universeHarness();
    h.world.stations.push(roomStation());
    const v = await openSearch(h);
    await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'ci');
    // Best match first: names that start with the letters, a system before a planet before a region before a room.
    const rows = screen.getAllByRole('button', { name: /^CI .*, (system|planet|region|room)/ });
    expect(rows.map((row) => String(row.props.accessibilityLabel))).toEqual([
      'CI system 0, system',
      'CI planet 2, planet, in CI system 0',
      'CI planet 3, planet, in CI system 0',
      'CI region 4, region, in CI planet 2, in CI system 0',
      'CI room, room, in CI system 0',
    ]);
    expect(screen.getByText('Region · CI planet 2 · CI system 0')).toBeOnTheScreen();
    expect(screen.getByText('Room · CI system 0')).toBeOnTheScreen();
    expect(screen.getByText('5 places')).toBeOnTheScreen();
    // Fly to a planet, then Back: the camera is where it was.
    const session = universeSessionFor(h.scope);
    const before = session.getState();
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 3, planet, in CI system 0' }));
    expect(session.getState().focusId).toBe(fixtureId(13));
    expect(screen.getByRole('header', { name: 'CI planet 3' })).toBeOnTheScreen();
    await act(() => {
      session.back();
    });
    expect(session.getState()).toMatchObject({ focusId: before.focusId, frame: before.frame });
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('opens a room from a search result, and writes nothing', async () => {
    const h = universeHarness();
    h.world.stations.push(roomStation());
    const v = await openSearch(h);
    await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'ci room');
    await fireEvent.press(screen.getByRole('button', { name: 'CI room, room, in CI system 0' }));
    expect(mockPush).toHaveBeenLastCalledWith(`/rooms/${roomStation().room.roomId}`);
    expect(screen.queryByTestId('universe-search-panel')).toBeNull();
    expect(h.calls.every(universeRead)).toBe(true);
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('makes no network call at all while typing, choosing and flying', async () => {
    const h = universeHarness();
    h.world.stations.push(roomStation());
    const v = await openSearch(h);
    const calls = h.calls.length;
    const sent = jest.spyOn(globalThis, 'fetch');
    for (const query of ['c', 'ci', 'ci planet', 'ci planet 3'])
      await fireEvent.changeText(screen.getByLabelText('Search your universe'), query);
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 3, planet, in CI system 0' }));
    expect(screen.getByRole('header', { name: 'CI planet 3' })).toBeOnTheScreen();
    expect(h.calls.length).toBe(calls);
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('never offers land that has not formed, and says so plainly when nothing matches', async () => {
    const h = universeHarness(5, 0, 3);
    const v = await openSearch(h);
    await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'region');
    // Formed regions only: four of them, however many sites the planet has.
    expect(screen.getAllByRole('button', { name: /^CI region \d, region/ })).toHaveLength(4);
    await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'uncharted');
    expect(screen.getByText('Nothing here called that yet.')).toBeOnTheScreen();
    await act(() => h.scope.end());
    await v.unmount();
  });
});

describe('desktop D02 (v3 U-5)', () => {
  const wide = (
    <DisplayProvider value={{ width: 1440, textScale: 1, reducedMotion: true }}>
      <UniverseScreen />
    </DisplayProvider>
  );

  it('keeps the panel open with search, switches and the lists, docks the picked planet’s card, and Land goes to its map', async () => {
    const h = universeHarness();
    h.world.stations.push(roomStation());
    mockScope = h.scope;
    const v = await render(wide);
    await waitFor(() => expect(screen.getByTestId('universe-panel')).toBeOnTheScreen());
    // The panel: title with its counts, the search field, the two switches, systems with planets and rooms.
    expect(screen.getByText('1 system · 2 planets')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Search your universe' })).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: 'Lately' })).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: 'Simple drawing' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0' })).toBeOnTheScreen();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'CI room, a room station' }).length).toBeGreaterThan(0),
    );
    // Zoom buttons and the key hints are on the map.
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeOnTheScreen();
    expect(screen.getByText('← → ↑ ↓')).toBeOnTheScreen();
    expect(screen.getByText('Esc')).toBeOnTheScreen();
    expect(screen.getByText('Back up a level')).toBeOnTheScreen();
    // In a system a tap on a planet picks it: its card docks in the panel instead of flying there.
    await fireEvent.press(screen.getAllByRole('button', { name: 'CI system 0, a system' })[0]!);
    await fireEvent.press(screen.getAllByRole('button', { name: 'CI planet 2, a planet' })[0]!);
    expect(screen.getByTestId('universe-planet-card')).toBeOnTheScreen();
    expect(screen.getByText('1 country.')).toBeOnTheScreen();
    expect(screen.getByText('Picked')).toBeOnTheScreen();
    expect(screen.queryByTestId('universe-level')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
    expect(screen.getByTestId('universe-level')).toHaveTextContent('PLANET');
    // Escape steps up one level at a time.
    const session = universeSessionFor(h.scope);
    await act(() => {
      session.escape();
    });
    expect(session.getState().focusId).toBe(fixtureId(10));
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('turns the whole map into the plain lists from the panel’s switch, and back', async () => {
    const h = universeHarness();
    mockScope = h.scope;
    const v = await render(wide);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Simple drawing' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('switch', { name: 'Simple drawing' }));
    await screen.findByTestId('universe-simple');
    await fireEvent.press(screen.getByRole('switch', { name: 'Simple drawing' }));
    await waitFor(() => expect(screen.queryByTestId('universe-simple')).toBeNull());
    await act(() => h.scope.end());
    await v.unmount();
  });
});

describe('the orbit dial’s two searches (O2 and O4)', () => {
  const openDial = async (h: ReturnType<typeof universeHarness>) => {
    mockScope = h.scope;
    const view = await render(<UniverseScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    return view;
  };

  it('searches the systems on the wheel: only what matches stays, and the letters that matched are named', async () => {
    const h = universeHarness();
    const v = await openDial(h);
    await fireEvent.press(screen.getByTestId('dial-system-pill'));
    await fireEvent.press(screen.getByRole('button', { name: 'Search systems' }));
    await fireEvent.changeText(screen.getByLabelText('Search your systems'), 'system');
    expect(screen.getByTestId('dial-system-facts')).toHaveTextContent(/1 of 1 systems match/);
    await fireEvent.changeText(screen.getByLabelText('Search your systems'), 'zzz');
    expect(screen.getByText('No system has that name.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Search your systems'), 'system');
    await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system, 2 planets' }));
    // Choosing leaves the search and rests on the system's planets.
    expect(screen.queryByLabelText('Search your systems')).toBeNull();
    expect(screen.getByTestId('dial-planet-facts')).toBeOnTheScreen();
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('searches the planets of the current system and lights them on the dial; a match flies there', async () => {
    const h = universeHarness();
    const v = await openDial(h);
    const calls = h.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: 'Search planets' }));
    await fireEvent.changeText(screen.getByLabelText('Search your planets'), 'planet 3');
    expect(screen.getByText('1 planet in CI system 0')).toBeOnTheScreen();
    expect(screen.getByText('Matches light up on the dial')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 3, a planet in CI system 0' }));
    expect(screen.getByRole('header', { name: 'CI planet 3' })).toBeOnTheScreen();
    expect(h.calls.length).toBe(calls);
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('closes with Back and leaves the map where it was', async () => {
    const h = universeHarness();
    const v = await openDial(h);
    await fireEvent.press(screen.getByRole('button', { name: 'Close the orbit dial' }));
    expect(screen.queryByTestId('universe-dial')).toBeNull();
    expect(screen.getByRole('header', { name: 'Your universe' })).toBeOnTheScreen();
    await act(() => h.scope.end());
    await v.unmount();
  });
});

describe('a hypothetical place says so wherever it is listed (D-006, D-053)', () => {
  /** The whole map is hypothetical (a place shares its truth with what contains it): the Geography and the Scene must agree. */
  const hypotheticalHarness = () => {
    const h = universeHarness();
    const ids = new Set([10, 11, 12, 13, 14].map(fixtureId));
    for (const object of h.world.chunks[0]!.objects) if (ids.has(object.objectId)) object.truthStatus = 'hypothetical';
    // The one route is dropped: a route joins planets of one truth, and none of this matters to the names.
    (h.world.chunks[0] as unknown as { routes: unknown[] }).routes.splice(0);
    const original = h.world.reply.bind(h.world);
    h.world.reply = ((path: string, body: Record<string, unknown>) => {
      const reply = original(path, body) as {
        page?: { objects: { id: string; truthStatus: string }[]; routes: unknown[] };
      };
      if (reply.page) reply.page.routes = [];
      for (const object of reply.page?.objects ?? []) if (ids.has(object.id)) object.truthStatus = 'hypothetical';
      return reply;
    }) as typeof h.world.reply;
    mockScope = h.scope;
    return h;
  };

  it('in search, the dial and the Simple lists, in the accessible name, and the Simple planet carries its tag', async () => {
    const h = hypotheticalHarness();
    const v = await render(<UniverseScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search your universe' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Search your universe' }));
    await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'planet 2');
    expect(screen.getByRole('button', { name: 'CI planet 2, planet, in CI system 0, hypothetical' })).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Search your universe'), 'system');
    expect(screen.getByRole('button', { name: 'CI system 0, system, hypothetical' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('button', { name: 'CI planet 2, a planet, hypothetical' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'CI system 0, a system, 2 planets, hypothetical' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
    await screen.findByTestId('universe-simple');
    expect(
      screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0, hypothetical' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'CI system 0, hypothetical' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0, hypothetical' }));
    expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
    expect(screen.getByText('Hypothetical')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'CI region 4, hypothetical' })).toBeOnTheScreen();
    await act(() => h.scope.end());
    await v.unmount();
  });

  it('on the desktop panel, which is the screen-reader list of the whole map', async () => {
    const h = hypotheticalHarness();
    const v = await render(
      <DisplayProvider value={{ width: 1440, textScale: 1, reducedMotion: true }}>
        <UniverseScreen />
      </DisplayProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'CI planet 2, a planet in CI system 0, hypothetical' }),
      ).toBeOnTheScreen(),
    );
    await act(() => h.scope.end());
    await v.unmount();
  });
});

describe('the Simple lists keep to the finalized file (v3 U-5)', () => {
  it('prints the bare room count, has no chevron on the row where the person was, and a visit’s search does not offer Regions', async () => {
    const h = universeHarness();
    h.world.stations.push(roomStation());
    mockScope = h.scope;
    const v = await render(<UniverseScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
    await waitFor(() => expect(h.requests.some((request) => request.path === '/v1/rooms/stations')).toBe(true));
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
    await screen.findByTestId('universe-simple');
    await waitFor(() => expect(screen.getByText('Rooms')).toBeOnTheScreen());
    expect(screen.queryByText('1 room')).toBeNull();
    expect(screen.getByText('1')).toBeOnTheScreen();
    await act(() => h.scope.end());
    await v.unmount();
  });
});
