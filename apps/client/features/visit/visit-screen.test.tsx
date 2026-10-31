import type * as React from 'react';
import type * as FakeGpu from '../universe/space/fake-space-gpu';
import type { EffectCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { visitServer } from '@knowscroll/client-core/visit-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { fakeGpu, resetFakeGpu } from '../universe/space/fake-space-gpu';
import { VisitScreen } from './visit-screen';

let mockScope: AccountScope;
const mockNavigate = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'A',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useIsFocused: () => true,
    useRouter: () => ({
      navigate: mockNavigate,
      back: mockBack,
      replace: mockReplace,
      canGoBack: () => mockCanGoBack,
    }),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
// The real stage and overlay over a stand-in for the GPU (no WebGL claimed).
jest.mock('../universe/space/space-canvas', () => ({
  SpaceCanvas: jest.requireActual<typeof FakeGpu>('../universe/space/fake-space-gpu').fakeGpu.Canvas,
}));
jest.mock('../universe/space/load-space-renderer', () => ({
  loadSpaceRenderer: () => jest.requireActual<typeof FakeGpu>('../universe/space/fake-space-gpu').fakeGpu.load(),
}));
beforeEach(() => {
  jest.clearAllMocks();
  resetFakeGpu();
  mockCanGoBack = true;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

const view = (visible: boolean) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
    {visible ? <VisitScreen handle="fixture.ravi" /> : null}
  </DisplayProvider>
);

/** The subtree of a rendered tree with this testID. */
function findByTestId(node: unknown, testID: string): unknown {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testID);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== 'object') return undefined;
  const { props, children } = node as { props?: { testID?: string }; children?: unknown };
  return props?.testID === testID ? node : findByTestId(children, testID);
}

/** Every string a rendered tree draws, in order. */
function textOf(node: unknown, found: string[] = []): string {
  if (typeof node === 'string') found.push(node);
  else if (Array.isArray(node)) for (const child of node) textOf(child, found);
  else if (node && typeof node === 'object') textOf((node as { children?: unknown }).children, found);
  return found.join(' | ');
}

describe('friend visit screen (labelled in-memory server)', () => {
  it('draws the shared systems with the Universe renderer under a visitor bar, and nothing else of the owner', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Machine learning, a system' })).toBeOnTheScreen());
    expect(screen.getByRole('header', { name: 'Visiting Ravi fixture' })).toBeOnTheScreen();
    expect(screen.getByText('Only what Ravi fixture shares')).toBeOnTheScreen();
    // The root header names no avatar, no Lately and no "Your universe".
    expect(screen.queryByText('Your universe')).toBeNull();
    expect(screen.queryByRole('togglebutton', { name: 'Lately' })).toBeNull();
    // The request is the visit read and nothing else of the owner's: no scene, geography or evidence.
    expect(server.requests.map((request) => request.path)).toEqual(['/v1/social/visits/read']);
    // The 3D layer is given a look derived on this device from the public ids, and nothing personal: no stations, dust, ship or Lately.
    const definition = fakeGpu.renderers.at(-1)!.definition;
    expect(definition.systems.length).toBeGreaterThan(0);
    expect(definition.stations).toEqual([]);
    expect(definition.dust).toEqual([]);
    expect(definition.shipPlanetId).toBeUndefined();
    const planets = definition.systems.flatMap((system) => system.planets);
    expect(new Set(definition.systems.map((system) => system.family)).size).toBe(definition.systems.length);
    expect(new Set(planets.map((planet) => planet.type)).size).toBe(planets.length);
    for (const system of definition.systems) expect(system.calm).toBeUndefined();
    for (const planet of planets) expect(planet.calm).toBeUndefined();
    await rendered.unmount();
    server.scope.end();
  });

  it('flies into a shared system to its planets, with Back, and a planet carries no region hint', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Machine learning, a system' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Machine learning, a system' }));
    expect(screen.getByRole('header', { name: 'Machine learning' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Hardware, a planet' }));
    expect(screen.getByRole('header', { name: 'Hardware' })).toBeOnTheScreen();
    expect(screen.queryByText('Tap a region to land.')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Machine learning' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Ravi fixture’s universe' }));
    expect(screen.getByRole('button', { name: 'Machine learning, a system' })).toBeOnTheScreen();
    await rendered.unmount();
    server.scope.end();
  });

  it('lists every shared place in the list view, named for the owner', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByText('Ravi fixture’s universe')).toBeOnTheScreen();
    expect(screen.getByText('Inference and serving')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Lately' })).toBeNull();
    await rendered.unmount();
    server.scope.end();
  });

  it('shows a friend’s universe as the plain lists too: their name, only what they share, no rooms and no regions', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
    await screen.findByTestId('universe-simple');
    expect(screen.getByText('Ravi fixture’s universe')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Hardware, a planet in Machine learning' })).toBeOnTheScreen();
    // Regions are never shared, so no row counts them, and a visit has no rooms.
    expect(screen.queryByText(/countr/i)).toBeNull();
    expect(screen.queryByText('Rooms')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lately' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Hardware, a planet in Machine learning' }));
    expect(screen.getByRole('header', { name: 'Hardware' })).toBeOnTheScreen();
    expect(screen.queryByText('Countries')).toBeNull();
    expect(server.requests.map((request) => request.path)).toEqual(['/v1/social/visits/read']);
    await rendered.unmount();
    server.scope.end();
  });

  it('explains private parts the same way every time, without saying whether any exist', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await fireEvent.press(await screen.findByRole('togglebutton', { name: 'Private parts stay private' }));
    expect(screen.getByTestId('visit-private-card')).toBeOnTheScreen();
    expect(screen.getByText(/or whether there are any/)).toBeOnTheScreen();
    await rendered.unmount();
    server.scope.end();
  });

  it('reads the same whatever is shared, so the bar cannot say whether something is hidden (U06, D-047)', async () => {
    const bar = async (
      systems: { publicSystemId: string; label: string; planets: { publicPlanetId: string; label: string }[] }[],
    ) => {
      const server = visitServer();
      server.setWorld(systems);
      mockScope = server.scope;
      const rendered = await render(view(true));
      await waitFor(() => expect(screen.getByTestId('visitor-bar')).toBeOnTheScreen());
      const words = textOf(findByTestId(screen.toJSON(), 'visitor-bar'));
      await rendered.unmount();
      server.scope.end();
      return words;
    };
    const planet = (n: number) => ({
      publicPlanetId: `0199b000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      label: `Planet ${String(n)}`,
    });
    const one = [{ publicSystemId: '0199b000-0000-4000-8000-000000000001', label: 'One', planets: [planet(11)] }];
    const three = [
      { publicSystemId: '0199b000-0000-4000-8000-000000000001', label: 'One', planets: [planet(11)] },
      { publicSystemId: '0199b000-0000-4000-8000-000000000002', label: 'Two', planets: [planet(21), planet(22)] },
      { publicSystemId: '0199b000-0000-4000-8000-000000000003', label: 'Three', planets: [] },
    ];
    expect(await bar(one)).toBe(await bar(three));
  });

  it('says "not shared with you" for a refusal, without a name and without claiming it was ever shared', async () => {
    const server = visitServer();
    server.setAllowed(false);
    mockScope = server.scope;
    const rendered = await render(view(true));
    await screen.findByText('This universe isn’t shared with you');
    expect(screen.queryByText(/stopped sharing/)).toBeNull();
    expect(screen.queryByText('Ravi fixture')).toBeNull();
    await rendered.unmount();
    server.scope.end();
  });

  it('drops the whole drawing when the owner stops sharing, and says nothing is kept', async () => {
    jest.useFakeTimers();
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('button', { name: 'Machine learning, a system' })).toBeOnTheScreen();
    server.setAllowed(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText('Ravi fixture stopped sharing their universe')).toBeOnTheScreen();
    expect(screen.getByText(/Nothing from it is kept on your side/)).toBeOnTheScreen();
    expect(screen.queryByText('Machine learning')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Machine learning, a system' })).toBeNull();
    jest.useRealTimers();
    await rendered.unmount();
    server.scope.end();
  });

  it('leaves to the previous screen, or to Friends when there is none', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave this visit' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    mockCanGoBack = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Leave this visit' }));
    expect(mockReplace).toHaveBeenCalledWith('/friends');
    await rendered.unmount();
    server.scope.end();
  });

  it('stops asking and keeps nothing once the screen is gone or the scope ends', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(view(true));
    await screen.findByRole('button', { name: 'Machine learning, a system' });
    await rendered.rerender(view(false));
    const reads = server.countOf('/v1/social/visits/read');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.countOf('/v1/social/visits/read')).toBe(reads);
    await rendered.unmount();
    server.scope.end();
  });
});
