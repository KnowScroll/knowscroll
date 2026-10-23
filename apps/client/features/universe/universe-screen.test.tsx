import type * as React from 'react';
import { type EffectCallback, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { UniverseScreen } from './universe-screen';
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
const mockNavigate = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useRouter: () => ({ navigate: mockNavigate, canGoBack: () => false }),
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
  mockNavigate.mockReset();
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
  expect(h.calls.every((p) => p.startsWith('/v1/universe/'))).toBe(true);
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
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4, region' }));
  await waitFor(() => expect(screen.getByText('Encounters from this region aren’t available yet.')).toBeOnTheScreen());
  await waitFor(() => expect(h.calls.filter((p) => p.endsWith('/region/preview'))).toHaveLength(1));
  expect(h.calls.every((p) => p.startsWith('/v1/universe/') || p === '/v1/experience/region/preview')).toBe(true);
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
  expect(h.calls.every((p) => p.startsWith('/v1/universe/') || p === '/v1/experience/region/preview')).toBe(true);
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

it('flies to the last place on ?focus=last', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const first = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await first.unmount();
  mockParams = { focus: 'last' };
  const second = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen());
  await act(() => h.scope.end());
  await second.unmount();
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
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4, region' }));
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
  expect(screen.getByRole('button', { name: 'CI region 4, a region' }).props.accessibilityState).toMatchObject({
    selected: true,
  });
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
