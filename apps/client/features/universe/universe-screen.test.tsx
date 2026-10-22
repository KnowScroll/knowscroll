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
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useRouter: () => ({ navigate: mockNavigate, canGoBack: () => false }),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
  mockNavigate.mockReset();
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
it('uses the actual mounted map/outline/card and does not manufacture a region encounter', async () => {
  const h = universeHarness();
  mockScope = h.scope;
  const v = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4 · region' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Place details' }));
  await waitFor(() => expect(screen.getByText('Encounters from this place aren’t available.')).toBeOnTheScreen());
  await waitFor(() => expect(h.calls.filter((p) => p.endsWith('/region/preview'))).toHaveLength(1));
  expect(h.calls.every((p) => p.startsWith('/v1/universe/') || p === '/v1/experience/region/preview')).toBe(true);
  expect(h.calls.some((p) => /region\/open|activate|observations/.test(p))).toBe(false);
  await act(() => h.scope.end());
  expect(screen.queryByText('CI region 4')).toBeNull();
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
  mockScope = scope;
  const view = await render(<UniverseScreen />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI region 4 · region' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Place details' }));
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
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('heading', { name: /^CI region 4$/ })).toBeOnTheScreen();
  await act(() => scope.end());
  await view.unmount();
});
