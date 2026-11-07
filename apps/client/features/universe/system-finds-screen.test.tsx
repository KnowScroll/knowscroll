import type * as React from 'react';
import type * as FakeGpu from './space/fake-space-gpu';
import { type EffectCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { UniverseScreen } from './universe-screen';
import { resetFakeGpu } from './space/fake-space-gpu';
import { COLLECTION_READS, fixtureId, universeHarness } from './universe.fixture';
import { universeSessionFor } from './use-universe-session';

/**
 * A system's Reels and Scrolls on the Universe (#697): the way in from a system, with or without a planet, over the real
 * session and screen with a stand-in for the GPU. Authored fixtures only; no title here names real content.
 */
let mockScope: AccountScope;
jest.mock('../../platform/command-id', () => {
  let next = 40000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
jest.mock('./space/space-canvas', () => ({
  SpaceCanvas: jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.Canvas,
}));
jest.mock('./space/load-space-renderer', () => ({
  loadSpaceRenderer: () => jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.load(),
}));
const mockNavigate = jest.fn();
const mockPush = jest.fn();
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
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
  resetFakeGpu();
  mockNavigate.mockReset();
  mockPush.mockReset();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

const FINDS_READ = '/v1/universe/system/finds/read';
/** Reads only: the map, the collection, the stations and the system's finds. Nothing opens, activates or records. */
const onlyReads = (calls: readonly string[]) =>
  calls.every(
    (path) =>
      path.startsWith('/v1/universe/') ||
      path === '/v1/rooms/stations' ||
      path === '/v1/account/universe/first-open' ||
      COLLECTION_READS.includes(path),
  );

async function open(h: ReturnType<typeof universeHarness>) {
  mockScope = h.scope;
  const view = await render(
    <DisplayProvider value={{ width: 750, textScale: 1, reducedMotion: true }}>
      <UniverseScreen />
    </DisplayProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  return view;
}

it('opens a system’s Reels and Scrolls from the system, each by its own address, and records nothing', async () => {
  const h = universeHarness();
  h.world.systemFinds.finds = [
    { assetId: fixtureId(600), assetRevision: 1, kind: 'reel', title: 'A watched fixture' },
    { assetId: fixtureId(601), assetRevision: 2, kind: 'scroll', title: 'A read fixture' },
  ];
  const v = await open(h);
  // Nothing is read for a system until its list is opened.
  expect(h.calls).not.toContain(FINDS_READ);
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Watch or read in CI system 0' }));
  expect(await screen.findByTestId('universe-system-finds')).toBeOnTheScreen();
  await fireEvent.press(await screen.findByRole('link', { name: 'Watch A watched fixture' }));
  expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/reel/[assetId]', params: { assetId: fixtureId(600) } });
  await fireEvent.press(screen.getByRole('link', { name: 'Read A read fixture' }));
  expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/scroll/[assetId]', params: { assetId: fixtureId(601) } });
  expect(h.calls.filter((path) => path === FINDS_READ)).toHaveLength(1);
  expect(h.requests.find((r) => r.path === FINDS_READ)?.body).toMatchObject({
    version: 'universe-system-finds.v1',
    systemId: h.world.descriptors.find((d) => d.kind === 'system')!.objectId,
  });
  expect(onlyReads(h.calls)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('reaches a system with no planet yet, and says plainly which formats it has nothing in', async () => {
  // One system and nothing under it: a system forms before its first planet (blueprint §12).
  const h = universeHarness(1);
  h.world.systemFinds.finds = [{ assetId: fixtureId(602), assetRevision: 1, kind: 'scroll', title: 'Only a Scroll' }];
  const v = await open(h);
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Watch or read in CI system 0' }));
  expect(await screen.findByRole('link', { name: 'Read Only a Scroll' })).toBeOnTheScreen();
  expect(screen.getByText('No Reels in CI system 0 yet.')).toBeOnTheScreen();
  expect(screen.queryByText('No Scrolls in CI system 0 yet.')).toBeNull();
  await act(() => h.scope.end());
  await v.unmount();
});

it('says a system has nothing yet, closes with Close or Back, and returns to the system it was opened from', async () => {
  const h = universeHarness();
  const v = await open(h);
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Watch or read in CI system 0' }));
  expect(await screen.findByText('No Reels in CI system 0 yet.')).toBeOnTheScreen();
  expect(screen.getByText('No Scrolls in CI system 0 yet.')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByTestId('universe-system-finds')).toBeNull();
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Watch or read in CI system 0' }));
  expect(await screen.findByTestId('universe-system-finds')).toBeOnTheScreen();
  await act(() => {
    universeSessionBack(h);
  });
  expect(screen.queryByTestId('universe-system-finds')).toBeNull();
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});

it('says so when the system is no longer on the map, and offers no link that leads nowhere', async () => {
  const h = universeHarness();
  h.world.systemFinds.away = true;
  const v = await open(h);
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Watch or read in CI system 0' }));
  expect(await screen.findByText('CI system 0 is no longer on your map.')).toBeOnTheScreen();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  await act(() => h.scope.end());
  await v.unmount();
});

it('offers the same way in from the plain list of the Simple drawing', async () => {
  const h = universeHarness();
  h.world.systemFinds.finds = [{ assetId: fixtureId(603), assetRevision: 1, kind: 'reel', title: 'Listed Reel' }];
  const v = await open(h);
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
  await screen.findByTestId('universe-simple');
  await fireEvent.press(screen.getByRole('button', { name: 'Watch or read in CI system 0' }));
  expect(await screen.findByRole('link', { name: 'Watch Listed Reel' })).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});

function universeSessionBack(h: ReturnType<typeof universeHarness>) {
  // The hardware or browser Back goes through the session, as the screen's own Back handler does.
  universeSessionFor(h.scope).back();
}
