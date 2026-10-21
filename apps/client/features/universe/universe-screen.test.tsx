import type * as React from 'react';
import { type EffectCallback, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { UniverseScreen } from './universe-screen';
import { universeHarness } from './universe.fixture';
import type { AccountScope } from '@knowscroll/client-core';
let mockScope: AccountScope;
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useRouter: () => ({ navigate: jest.fn(), canGoBack: () => false }),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
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
  expect(screen.getByText('Encounters from this place aren’t available.')).toBeOnTheScreen();
  expect(h.calls.every((p) => p.startsWith('/v1/universe/'))).toBe(true);
  await act(() => h.scope.end());
  expect(screen.queryByText('CI region 4')).toBeNull();
  await v.unmount();
});
